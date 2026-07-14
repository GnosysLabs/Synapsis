/**
 * Bot Activity Logs API Route
 * 
 * GET /api/bots/[id]/logs - Get activity logs with filters
 * 
 * Requirements: 8.2, 8.6
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, bots } from '@/db';
import { eq } from 'drizzle-orm';
import { getLogsForBot, type ActionType } from '@/lib/bots/activityLogger';

export async function GET(
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
    
    const { id: botId } = await params;
    
    // Verify bot exists and user owns it
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
    
    if (bot.userId !== session.user.id) {
      return NextResponse.json(
        { error: 'Not authorized' },
        { status: 403 }
      );
    }
    
    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const actionTypes = searchParams.get('actionTypes')?.split(',') as ActionType[] | undefined;
    const startDate = searchParams.get('startDate') ? new Date(searchParams.get('startDate')!) : undefined;
    const endDate = searchParams.get('endDate') ? new Date(searchParams.get('endDate')!) : undefined;
    const limit = searchParams.get('limit') ? parseInt(searchParams.get('limit')!) : undefined;
    const offset = searchParams.get('offset') ? parseInt(searchParams.get('offset')!) : undefined;
    
    // Get logs
    const logs = await getLogsForBot(botId, {
      actionTypes,
      startDate,
      endDate,
      limit,
      offset,
    });
    
    return NextResponse.json({ logs, count: logs.length });
  } catch (error) {
    console.error('Error fetching bot logs:', error);
    return NextResponse.json(
      { error: 'Failed to fetch logs' },
      { status: 500 }
    );
  }
}
