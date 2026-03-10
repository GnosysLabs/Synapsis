/**
 * Bot Detail API Routes
 * 
 * GET /api/bots/[id] - Get bot details
 * PUT /api/bots/[id] - Update bot
 * DELETE /api/bots/[id] - Delete bot
 * 
 * Requirements: 1.1, 1.3, 1.4
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { z } from 'zod';
import {
  getBotById,
  updateBot,
  deleteBot,
  userOwnsBot,
  BotNotFoundError,
  BotValidationError,
} from '@/lib/bots/botManager';

type RouteContext = { params: Promise<{ id: string }> };

// Schema for updating a bot
const updateBotSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  bio: z.string().max(500).optional().nullable(),
  avatarUrl: z.string().url().optional().nullable(),
  headerUrl: z.string().url().optional().nullable(),
  personality: z.object({
    systemPrompt: z.string().min(1).max(10000),
    temperature: z.number().min(0).max(2),
    maxTokens: z.number().int().min(1).max(100000),
    responseStyle: z.string().optional(),
  }).optional(),
  llmProvider: z.enum(['openrouter', 'openai', 'anthropic', 'custom']).optional(),
  llmModel: z.string().min(1).optional(),
  llmEndpoint: z.string().url().optional().nullable(),
  llmApiKey: z.string().min(1).optional(),
  schedule: z.object({
    type: z.enum(['interval', 'times', 'cron']),
    intervalMinutes: z.number().int().min(5).optional(),
    times: z.array(z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)).optional(),
    cronExpression: z.string().optional(),
    timezone: z.string().optional(),
  }).optional().nullable(),
  autonomousMode: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

/**
 * GET /api/bots/[id] - Get bot details
 * 
 * Requires authentication.
 * Returns the bot details if the user owns the bot.
 * 
 * Validates: Requirements 1.3
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await requireAuth();
    const { id } = await context.params;

    // Check if user owns the bot
    const isOwner = await userOwnsBot(user.id, id);
    if (!isOwner) {
      // Check if bot exists at all
      const bot = await getBotById(id);
      if (!bot) {
        return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
      }
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const bot = await getBotById(id);
    if (!bot) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
    }

    // Return bot without sensitive data (API keys)
    return NextResponse.json({
      success: true,
      bot: {
        id: bot.id,
        userId: bot.userId,
        name: bot.name,
        handle: bot.handle,
        bio: bot.bio,
        avatarUrl: bot.avatarUrl,
        headerUrl: bot.headerUrl,
        personalityConfig: bot.personalityConfig,
        llmProvider: bot.llmProvider,
        llmModel: bot.llmModel,
        llmEndpoint: bot.llmEndpoint,
        scheduleConfig: bot.scheduleConfig,
        autonomousMode: bot.autonomousMode,
        isActive: bot.isActive,
        isSuspended: bot.isSuspended,
        suspensionReason: bot.suspensionReason,
        suspendedAt: bot.suspendedAt,
        publicKey: bot.publicKey,
        lastPostAt: bot.lastPostAt,
        createdAt: bot.createdAt,
        updatedAt: bot.updatedAt,
      },
    });
  } catch (error) {
    console.error('Get bot error:', error);

    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    return NextResponse.json(
      { error: 'Failed to get bot' },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/bots/[id] - Update bot (full update)
 * PATCH /api/bots/[id] - Update bot (partial update)
 * 
 * Requires authentication.
 * Updates the bot configuration if the user owns the bot.
 * 
 * Validates: Requirements 1.1
 */
export async function PUT(request: Request, context: RouteContext) {
  return handleUpdate(request, context);
}

export async function PATCH(request: Request, context: RouteContext) {
  return handleUpdate(request, context);
}

async function handleUpdate(request: Request, context: RouteContext) {
  try {
    const user = await requireAuth();
    const { id } = await context.params;
    const body = await request.json();
    const data = updateBotSchema.parse(body);

    // Check if user owns the bot
    const isOwner = await userOwnsBot(user.id, id);
    if (!isOwner) {
      // Check if bot exists at all
      const bot = await getBotById(id);
      if (!bot) {
        return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
      }
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    // Build update input
    const updateInput: Parameters<typeof updateBot>[1] = {};
    
    if (data.name !== undefined) updateInput.name = data.name;
    if (data.bio !== undefined) updateInput.bio = data.bio ?? undefined;
    if (data.avatarUrl !== undefined) updateInput.avatarUrl = data.avatarUrl ?? undefined;
    if (data.headerUrl !== undefined) updateInput.headerUrl = data.headerUrl ?? undefined;
    if (data.personality !== undefined) updateInput.personality = data.personality;
    if (data.llmProvider !== undefined) updateInput.llmProvider = data.llmProvider;
    if (data.llmModel !== undefined) updateInput.llmModel = data.llmModel;
    if (data.llmEndpoint !== undefined) updateInput.llmEndpoint = data.llmEndpoint;
    if (data.llmApiKey !== undefined) updateInput.llmApiKey = data.llmApiKey;
    if (data.schedule !== undefined) updateInput.schedule = data.schedule;
    if (data.autonomousMode !== undefined) updateInput.autonomousMode = data.autonomousMode;
    if (data.isActive !== undefined) updateInput.isActive = data.isActive;

    const updatedBot = await updateBot(id, updateInput);

    // Return updated bot without sensitive data
    return NextResponse.json({
      success: true,
      bot: {
        id: updatedBot.id,
        userId: updatedBot.userId,
        name: updatedBot.name,
        handle: updatedBot.handle,
        bio: updatedBot.bio,
        avatarUrl: updatedBot.avatarUrl,
        headerUrl: updatedBot.headerUrl,
        personalityConfig: updatedBot.personalityConfig,
        llmProvider: updatedBot.llmProvider,
        llmModel: updatedBot.llmModel,
        llmEndpoint: updatedBot.llmEndpoint,
        scheduleConfig: updatedBot.scheduleConfig,
        autonomousMode: updatedBot.autonomousMode,
        isActive: updatedBot.isActive,
        isSuspended: updatedBot.isSuspended,
        suspensionReason: updatedBot.suspensionReason,
        lastPostAt: updatedBot.lastPostAt,
        createdAt: updatedBot.createdAt,
        updatedAt: updatedBot.updatedAt,
      },
    });
  } catch (error) {
    console.error('Update bot error:', error);

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

    if (error instanceof BotValidationError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to update bot' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/bots/[id] - Delete bot
 * 
 * Requires authentication.
 * Deletes the bot and all associated data if the user owns the bot.
 * 
 * Validates: Requirements 1.4
 */
export async function DELETE(request: Request, context: RouteContext) {
  try {
    const user = await requireAuth();
    const { id } = await context.params;

    // Check if user owns the bot
    const isOwner = await userOwnsBot(user.id, id);
    if (!isOwner) {
      // Check if bot exists at all
      const bot = await getBotById(id);
      if (!bot) {
        return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
      }
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    await deleteBot(id);

    return NextResponse.json({
      success: true,
      message: 'Bot deleted successfully',
    });
  } catch (error) {
    console.error('Delete bot error:', error);

    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    if (error instanceof BotNotFoundError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to delete bot' },
      { status: 500 }
    );
  }
}
