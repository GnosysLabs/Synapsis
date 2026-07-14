/**
 * Bot Mention Response API Route
 * 
 * POST /api/bots/[id]/mentions/[mid]/respond - Manually respond to a mention
 * 
 * Requirements: 7.1
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, bots } from '@/db';
import { eq } from 'drizzle-orm';
import { processMention, getMentionById } from '@/lib/bots/mentionHandler';

/**
 * POST /api/bots/[id]/mentions/[mid]/respond
 * 
 * Manually trigger a response to a specific mention.
 * Checks rate limits and generates a reply using the bot's LLM.
 * 
 * Validates: Requirements 7.1
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; mid: string }> }
) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }
    
    const { id: botId, mid: mentionId } = await params;
    
    // Verify bot exists and user owns it
    const bot = await db.query.bots.findFirst({
      where: { id: botId },
      columns: {
        id: true,
        userId: true,
        isSuspended: true,
      },
    });
    
    if (!bot) {
      return NextResponse.json(
        { error: 'Bot not found' },
        { status: 404 }
      );
    }
    
    if (bot.userId !== session.user.id) {
      return NextResponse.json(
        { error: 'Not authorized to access this bot' },
        { status: 403 }
      );
    }
    
    if (bot.isSuspended) {
      return NextResponse.json(
        { error: 'Bot is suspended' },
        { status: 403 }
      );
    }
    
    // Verify mention exists and belongs to this bot
    const mention = await getMentionById(mentionId);
    
    if (!mention) {
      return NextResponse.json(
        { error: 'Mention not found' },
        { status: 404 }
      );
    }
    
    if (mention.botId !== botId) {
      return NextResponse.json(
        { error: 'Mention does not belong to this bot' },
        { status: 400 }
      );
    }
    
    // Process the mention
    const result = await processMention(mentionId);
    
    if (!result.success) {
      // Check if it's a rate limit error
      if (result.error?.includes('rate limit') || result.error?.includes('Rate limit')) {
        return NextResponse.json(
          { error: result.error },
          { status: 429 }
        );
      }
      
      return NextResponse.json(
        { error: result.error || 'Failed to process mention' },
        { status: 500 }
      );
    }
    
    return NextResponse.json({
      success: true,
      responsePostId: result.responsePostId,
      message: 'Reply posted successfully',
    });
  } catch (error) {
    console.error('Error responding to mention:', error);
    return NextResponse.json(
      { error: 'Failed to respond to mention' },
      { status: 500 }
    );
  }
}
