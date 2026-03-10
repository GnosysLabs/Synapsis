/**
 * Bot API Routes
 * 
 * POST /api/bots - Create a new bot
 * GET /api/bots - List user's bots
 * 
 * Requirements: 1.1, 1.3
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { z } from 'zod';
import {
  createBot,
  getBotsByUser,
  BotLimitExceededError,
  BotHandleTakenError,
  BotValidationError,
} from '@/lib/bots/botManager';
import { generateAndUploadAvatarToUserStorage } from '@/lib/storage/s3';
import { createStorageSession, getStorageSession } from '@/lib/storage/session';

// Schema for creating a bot
const createBotSchema = z.object({
  name: z.string().min(1).max(100),
  handle: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/, 'Handle must be alphanumeric and underscores only'),
  bio: z.string().max(500).optional(),
  avatarUrl: z.string().url().optional(),
  headerUrl: z.string().url().optional(),
  personality: z.object({
    systemPrompt: z.string().min(1).max(10000),
    temperature: z.number().min(0).max(2),
    maxTokens: z.number().int().min(1).max(100000),
    responseStyle: z.string().optional(),
  }),
  llmProvider: z.enum(['openrouter', 'openai', 'anthropic', 'custom']),
  llmModel: z.string().min(1),
  llmEndpoint: z.string().url().optional(),
  llmApiKey: z.string().min(1),
  schedule: z.object({
    type: z.enum(['interval', 'times', 'cron']),
    intervalMinutes: z.number().int().min(5).optional(),
    times: z.array(z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)).optional(),
    cronExpression: z.string().optional(),
    timezone: z.string().optional(),
  }).optional(),
  autonomousMode: z.boolean().optional(),
  ownerPassword: z.string().optional(),
});

/**
 * POST /api/bots - Create a new bot
 * 
 * Requires authentication.
 * Creates a new bot linked to the authenticated user's account.
 * 
 * Validates: Requirements 1.1, 1.2
 */
export async function POST(request: Request) {
  try {
    const user = await requireAuth();
    const body = await request.json();
    const data = createBotSchema.parse(body);

    const storageSession =
      (await getStorageSession(user.id)) ||
      (data.ownerPassword ? await createStorageSession(user, data.ownerPassword) : null);

    // Generate bot avatar using owner's S3 storage if no avatar URL
    let botAvatarUrl: string | null | undefined = data.avatarUrl;
    if (!botAvatarUrl && storageSession) {
      try {
        const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:3000';
        const botHandle = `${data.handle.toLowerCase()}@${nodeDomain}`;

        botAvatarUrl = await generateAndUploadAvatarToUserStorage(
          botHandle,
          storageSession.endpoint || undefined,
          storageSession.publicBaseUrl || undefined,
          storageSession.region || 'us-east-1',
          storageSession.bucket,
          storageSession.accessKeyId,
          storageSession.secretAccessKey
        );
      } catch (err) {
        console.error('[Bot API] Failed to generate bot avatar:', err);
        // Continue without avatar - user can set it later
      }
    }

    const bot = await createBot(user.id, {
      name: data.name,
      handle: data.handle,
      bio: data.bio,
      avatarUrl: botAvatarUrl ?? undefined,
      headerUrl: data.headerUrl,
      personality: data.personality,
      llmProvider: data.llmProvider,
      llmModel: data.llmModel,
      llmEndpoint: data.llmEndpoint,
      llmApiKey: data.llmApiKey,
      schedule: data.schedule,
      autonomousMode: data.autonomousMode,
    });

    // Return bot without sensitive data
    return NextResponse.json({
      success: true,
      bot: {
        id: bot.id,
        userId: bot.userId,
        name: bot.name,
        handle: bot.handle,
        bio: bot.bio,
        avatarUrl: bot.avatarUrl,
        personalityConfig: bot.personalityConfig,
        llmProvider: bot.llmProvider,
        llmModel: bot.llmModel,
        llmEndpoint: bot.llmEndpoint,
        scheduleConfig: bot.scheduleConfig,
        autonomousMode: bot.autonomousMode,
        isActive: bot.isActive,
        isSuspended: bot.isSuspended,
        lastPostAt: bot.lastPostAt,
        createdAt: bot.createdAt,
        updatedAt: bot.updatedAt,
      },
    }, { status: 201 });
  } catch (error) {
    console.error('Create bot error:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid input', details: error.issues },
        { status: 400 }
      );
    }

    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    if (error instanceof BotLimitExceededError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 403 }
      );
    }

    if (error instanceof BotHandleTakenError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 409 }
      );
    }

    if (error instanceof BotValidationError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to create bot' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/bots - List user's bots
 * 
 * Requires authentication.
 * Returns all bots belonging to the authenticated user.
 * 
 * Validates: Requirements 1.3
 */
export async function GET() {
  try {
    const user = await requireAuth();
    const userBots = await getBotsByUser(user.id);

    // Return bots without sensitive data
    const sanitizedBots = userBots.map(bot => ({
      id: bot.id,
      userId: bot.userId,
      name: bot.name,
      handle: bot.handle,
      bio: bot.bio,
      avatarUrl: bot.avatarUrl,
      personalityConfig: bot.personalityConfig,
      llmProvider: bot.llmProvider,
      llmModel: bot.llmModel,
      llmEndpoint: bot.llmEndpoint,
      scheduleConfig: bot.scheduleConfig,
      autonomousMode: bot.autonomousMode,
      isActive: bot.isActive,
      isSuspended: bot.isSuspended,
      suspensionReason: bot.suspensionReason,
      lastPostAt: bot.lastPostAt,
      createdAt: bot.createdAt,
      updatedAt: bot.updatedAt,
    }));

    return NextResponse.json({
      success: true,
      bots: sanitizedBots,
    });
  } catch (error) {
    console.error('List bots error:', error);

    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    return NextResponse.json(
      { error: 'Failed to list bots' },
      { status: 500 }
    );
  }
}
