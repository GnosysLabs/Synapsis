/**
 * Bot Mentions API Routes
 * 
 * GET /api/bots/[id]/mentions - Get pending mentions for a bot
 * 
 * Requirements: 7.1
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, bots } from '@/db';
import { eq } from 'drizzle-orm';
import { getUnprocessedMentions, getAllMentions } from '@/lib/bots/mentionHandler';

/**
 * GET /api/bots/[id]/mentions
 * 
 * Get mentions for a bot. Returns unprocessed mentions by default,
 * or all mentions if ?all=true is provided.
 * 
 * Query Parameters:
 * - all: boolean - If true, return all mentions (processed and unprocessed)
 * 
 * Validates: Requirements 7.1
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
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
    
    const { id: botId } = await params;
    
    // Verify bot exists and user owns it
    const bot = await db.query.bots.findFirst({
      where: { id: botId },
      columns: {
        id: true,
        userId: true,
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
    
    // Get mentions based on query parameter
    const { searchParams } = new URL(request.url);
    const showAll = searchParams.get('all') === 'true';
    
    const mentions = showAll
      ? await getAllMentions(botId)
      : await getUnprocessedMentions(botId);
    
    return NextResponse.json({
      mentions,
      count: mentions.length,
      unprocessedOnly: !showAll,
    });
  } catch (error) {
    console.error('Error fetching bot mentions:', error);
    return NextResponse.json(
      { error: 'Failed to fetch mentions' },
      { status: 500 }
    );
  }
}
