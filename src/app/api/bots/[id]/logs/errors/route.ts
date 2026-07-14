/**
 * Bot Error Logs API Route
 * 
 * GET /api/bots/[id]/logs/errors - Get error logs only
 * 
 * Requirements: 8.6
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, bots } from '@/db';
import { eq } from 'drizzle-orm';
import { getErrorLogs } from '@/lib/bots/activityLogger';

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
    
    // Parse limit
    const { searchParams } = new URL(request.url);
    const limit = searchParams.get('limit') ? parseInt(searchParams.get('limit')!) : 50;
    
    // Get error logs
    const logs = await getErrorLogs(botId, limit);
    
    return NextResponse.json({ logs, count: logs.length });
  } catch (error) {
    console.error('Error fetching error logs:', error);
    return NextResponse.json(
      { error: 'Failed to fetch error logs' },
      { status: 500 }
    );
  }
}
