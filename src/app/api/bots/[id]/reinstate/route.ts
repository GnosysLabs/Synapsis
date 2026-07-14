/**
 * Bot Reinstatement API Route
 * 
 * POST /api/bots/[id]/reinstate - Reinstate a suspended bot (admin only)
 * 
 * Requirements: 10.6
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, bots } from '@/db';
import { eq } from 'drizzle-orm';
import { reinstateBot } from '@/lib/bots/suspension';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }
    
    // TODO: Add admin check here
    
    const { id: botId } = await params;
    
    // Verify bot exists
    const bot = await db.query.bots.findFirst({
      where: { id: botId },
      columns: { id: true, userId: true },
    });
    
    if (!bot) {
      return NextResponse.json(
        { error: 'Bot not found' },
        { status: 404 }
      );
    }
    
    // Reinstate the bot
    const reinstatedBot = await reinstateBot(botId);
    
    return NextResponse.json({
      success: true,
      bot: {
        id: reinstatedBot.id,
        isSuspended: reinstatedBot.isSuspended,
      },
    });
  } catch (error) {
    console.error('Error reinstating bot:', error);
    return NextResponse.json(
      { error: 'Failed to reinstate bot' },
      { status: 500 }
    );
  }
}
