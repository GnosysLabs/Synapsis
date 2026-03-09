/**
 * Content Source API Routes
 * 
 * POST /api/bots/[id]/sources - Add content source
 * GET /api/bots/[id]/sources - List content sources
 * 
 * Requirements: 4.1, 4.6
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { z } from 'zod';
import { userOwnsBot, getBotById } from '@/lib/bots/botManager';
import {
  addSource,
  getSourcesByBot,
  ContentSourceValidationError,
  BotNotFoundError,
  SUPPORTED_SOURCE_TYPES,
  MAX_KEYWORDS,
  MAX_KEYWORD_LENGTH,
} from '@/lib/bots/contentSource';
import { validateSourceReachability } from '@/lib/bots/contentSourceValidation';

type RouteContext = { params: Promise<{ id: string }> };

// Schema for Brave News config
const braveNewsConfigSchema = z.object({
  query: z.string().min(1, 'Search query is required'),
  freshness: z.enum(['pd', 'pw', 'pm', 'py']).optional(),
  country: z.string().length(2, 'Country must be a 2-letter ISO code').optional(),
  searchLang: z.string().optional(),
  count: z.number().min(1).max(50).optional(),
}).optional();

// Schema for News API config
const newsApiConfigSchema = z.object({
  provider: z.enum(['newsapi', 'gnews', 'newsdata']),
  query: z.string().min(1, 'Search query is required'),
  category: z.string().optional(),
  country: z.string().optional(),
  language: z.string().optional(),
}).optional();

// Schema for adding a content source
const addSourceSchema = z.object({
  type: z.enum(['rss', 'reddit', 'news_api', 'brave_news', 'youtube'], {
    message: `Source type must be one of: ${SUPPORTED_SOURCE_TYPES.join(', ')}`,
  }),
  url: z.string().url('URL must be a valid HTTP or HTTPS URL').max(2048, 'URL is too long'),
  subreddit: z.string()
    .regex(/^[a-zA-Z0-9_]{3,21}$/, 'Subreddit name must be 3-21 characters, alphanumeric and underscores only')
    .optional(),
  apiKey: z.string().min(10, 'API key is too short').max(256, 'API key is too long').optional(),
  keywords: z.array(
    z.string()
      .min(1, 'Keyword cannot be empty')
      .max(MAX_KEYWORD_LENGTH, `Keyword is too long (maximum ${MAX_KEYWORD_LENGTH} characters)`)
  )
    .max(MAX_KEYWORDS, `Maximum ${MAX_KEYWORDS} keywords allowed`)
    .optional(),
  braveNewsConfig: braveNewsConfigSchema,
  newsApiConfig: newsApiConfigSchema,
}).refine(
  (data) => {
    // Reddit sources require subreddit
    if (data.type === 'reddit' && !data.subreddit) {
      return false;
    }
    return true;
  },
  { message: 'Subreddit name is required for Reddit sources', path: ['subreddit'] }
).refine(
  (data) => {
    // News API and Brave News sources require apiKey
    if ((data.type === 'news_api' || data.type === 'brave_news') && !data.apiKey) {
      return false;
    }
    return true;
  },
  { message: 'API key is required for news API sources', path: ['apiKey'] }
).refine(
  (data) => {
    // Brave News sources require braveNewsConfig with query
    if (data.type === 'brave_news' && !data.braveNewsConfig?.query) {
      return false;
    }
    return true;
  },
  { message: 'Search query is required for Brave News sources', path: ['braveNewsConfig'] }
);

/**
 * POST /api/bots/[id]/sources - Add content source
 * 
 * Requires authentication.
 * Adds a new content source to the bot if the user owns the bot.
 * 
 * Validates: Requirements 4.1, 4.6
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const user = await requireAuth();
    const { id: botId } = await context.params;
    const body = await request.json();
    const data = addSourceSchema.parse(body);

    // Check if user owns the bot
    const isOwner = await userOwnsBot(user.id, botId);
    if (!isOwner) {
      // Check if bot exists at all
      const bot = await getBotById(botId);
      if (!bot) {
        return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
      }
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    await validateSourceReachability({
      type: data.type,
      url: data.url,
      subreddit: data.subreddit,
      apiKey: data.apiKey,
      keywords: data.keywords,
      braveNewsConfig: data.braveNewsConfig,
      newsApiConfig: data.newsApiConfig,
    });

    // Add the content source
    const source = await addSource(botId, {
      type: data.type,
      url: data.url,
      subreddit: data.subreddit,
      apiKey: data.apiKey,
      keywords: data.keywords,
      braveNewsConfig: data.braveNewsConfig,
      newsApiConfig: data.newsApiConfig,
    });

    return NextResponse.json({
      success: true,
      source: {
        id: source.id,
        botId: source.botId,
        type: source.type,
        url: source.url,
        subreddit: source.subreddit,
        keywords: source.keywords,
        sourceConfig: source.sourceConfig,
        isActive: source.isActive,
        lastFetchAt: source.lastFetchAt,
        lastError: source.lastError,
        consecutiveErrors: source.consecutiveErrors,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
      },
    }, { status: 201 });
  } catch (error) {
    console.error('Add content source error:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid input', details: error.issues },
        { status: 400 }
      );
    }

    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    if (error instanceof BotNotFoundError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 404 }
      );
    }

    if (error instanceof ContentSourceValidationError) {
      return NextResponse.json(
        { error: error.message, code: error.code, details: error.errors },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to add content source' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/bots/[id]/sources - List content sources
 * 
 * Requires authentication.
 * Returns all content sources for the bot if the user owns the bot.
 * 
 * Validates: Requirements 4.6
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const user = await requireAuth();
    const { id: botId } = await context.params;

    // Check if user owns the bot
    const isOwner = await userOwnsBot(user.id, botId);
    if (!isOwner) {
      // Check if bot exists at all
      const bot = await getBotById(botId);
      if (!bot) {
        return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
      }
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    // Get all sources for the bot
    const sources = await getSourcesByBot(botId);

    return NextResponse.json({
      success: true,
      sources: sources.map(source => ({
        id: source.id,
        botId: source.botId,
        type: source.type,
        url: source.url,
        subreddit: source.subreddit,
        keywords: source.keywords,
        sourceConfig: source.sourceConfig,
        isActive: source.isActive,
        lastFetchAt: source.lastFetchAt,
        lastError: source.lastError,
        consecutiveErrors: source.consecutiveErrors,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
      })),
    });
  } catch (error) {
    console.error('List content sources error:', error);

    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    return NextResponse.json(
      { error: 'Failed to list content sources' },
      { status: 500 }
    );
  }
}
