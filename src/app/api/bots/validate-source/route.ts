import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import { MAX_KEYWORDS, MAX_KEYWORD_LENGTH, SUPPORTED_SOURCE_TYPES, ContentSourceValidationError } from '@/lib/bots/contentSource';
import { validateSourceReachability } from '@/lib/bots/contentSourceValidation';

const braveNewsConfigSchema = z.object({
  query: z.string().min(1, 'Search query is required'),
  freshness: z.enum(['pd', 'pw', 'pm', 'py']).optional(),
  country: z.string().length(2, 'Country must be a 2-letter ISO code').optional(),
  searchLang: z.string().optional(),
  count: z.number().min(1).max(50).optional(),
}).optional();

const newsApiConfigSchema = z.object({
  provider: z.enum(['newsapi', 'gnews', 'newsdata']),
  query: z.string().min(1, 'Search query is required'),
  category: z.string().optional(),
  country: z.string().optional(),
  language: z.string().optional(),
}).optional();

const validateSourceSchema = z.object({
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
  (data) => data.type !== 'reddit' || !!data.subreddit,
  { message: 'Subreddit name is required for Reddit sources', path: ['subreddit'] }
).refine(
  (data) => !['news_api', 'brave_news'].includes(data.type) || !!data.apiKey,
  { message: 'API key is required for news API sources', path: ['apiKey'] }
).refine(
  (data) => data.type !== 'brave_news' || !!data.braveNewsConfig?.query,
  { message: 'Search query is required for Brave News sources', path: ['braveNewsConfig'] }
);

export async function POST(request: Request) {
  try {
    await requireAuth();
    const body = await request.json();
    const data = validateSourceSchema.parse(body);

    await validateSourceReachability({
      type: data.type,
      url: data.url,
      subreddit: data.subreddit,
      apiKey: data.apiKey,
      keywords: data.keywords,
      braveNewsConfig: data.braveNewsConfig,
      newsApiConfig: data.newsApiConfig,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid input', details: error.issues },
        { status: 400 }
      );
    }

    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    if (error instanceof ContentSourceValidationError) {
      return NextResponse.json(
        { error: error.message, code: error.code, details: error.errors },
        { status: 400 }
      );
    }

    console.error('Validate content source error:', error);
    return NextResponse.json(
      { error: 'Failed to validate content source' },
      { status: 500 }
    );
  }
}
