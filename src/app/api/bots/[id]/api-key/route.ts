/**
 * Bot API Key Management Routes
 * 
 * POST /api/bots/[id]/api-key - Set/update LLM API key
 * DELETE /api/bots/[id]/api-key - Remove API key
 * 
 * Requirements: 2.1, 2.2, 2.4
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { z } from 'zod';
import {
  getBotById,
  userOwnsBot,
  setApiKey,
  removeApiKey,
  BotNotFoundError,
  BotValidationError,
} from '@/lib/bots/botManager';

type RouteContext = { params: Promise<{ id: string }> };

// Schema for setting API key
const setApiKeySchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
  provider: z.enum(['openrouter', 'openai', 'anthropic', 'custom']).optional(),
});

/**
 * POST /api/bots/[id]/api-key - Set/update LLM API key
 * 
 * Requires authentication.
 * Sets or updates the API key for the bot's LLM provider.
 * The API key is validated and encrypted before storage.
 * 
 * Validates: Requirements 2.1, 2.2, 2.4
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const user = await requireAuth();
    const { id } = await context.params;
    const body = await request.json();
    const data = setApiKeySchema.parse(body);

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

    // Set the API key (validates format and encrypts)
    await setApiKey(id, data.apiKey, data.provider);

    return NextResponse.json({
      success: true,
      message: 'API key updated successfully',
    });
  } catch (error) {
    console.error('Set API key error:', error);

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
      { error: 'Failed to set API key' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/bots/[id]/api-key - Remove API key
 * 
 * Requires authentication.
 * Removes the API key from the bot, disabling LLM functionality.
 * 
 * Note: Since the llmApiKeyEncrypted field is NOT NULL in the schema,
 * this sets the key to an empty encrypted value, effectively disabling it.
 * 
 * Validates: Requirements 2.4
 */
export async function DELETE(_request: Request, context: RouteContext) {
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

    // Remove the API key
    await removeApiKey(id);

    return NextResponse.json({
      success: true,
      message: 'API key removed successfully',
    });
  } catch (error) {
    console.error('Remove API key error:', error);

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
      { error: 'Failed to remove API key' },
      { status: 500 }
    );
  }
}
