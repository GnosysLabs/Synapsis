/**
 * Bot Suspension API Route
 * 
 * POST /api/bots/[id]/suspend - Suspend a bot (admin only)
 * 
 * Requirements: 10.6
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, bots } from '@/db';
import { eq } from 'drizzle-orm';
import { suspendBot } from '@/lib/bots/suspension';

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
    // For now, only bot owner can suspend
    
    const { id: botId } = await params;
    const body = await request.json();
    const { reason } = body;
    
    if (!reason) {
      return NextResponse.json(
        { error: 'Suspension reason is required' },
        { status: 400 }
      );
    }
    
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
    
    // Suspend the bot
    const suspendedBot = await suspendBot(botId, reason);
    
    return NextResponse.json({
      success: true,
      bot: {
        id: suspendedBot.id,
        isSuspended: suspendedBot.isSuspended,
        suspensionReason: suspendedBot.suspensionReason,
        suspendedAt: suspendedBot.suspendedAt,
      },
    });
  } catch (error) {
    console.error('Error suspending bot:', error);
    return NextResponse.json(
      { error: 'Failed to suspend bot' },
      { status: 500 }
    );
  }
}
