import { NextResponse } from 'next/server';
import { chatConversations, chatMessages, db } from '@/db';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { getSession } from '@/lib/auth';

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Keep response work constant even if a hostile node has created a large
    // inbox. The database returns one aggregate row instead of materializing
    // every conversation ID and unread message in application memory.
    const [row] = await db
      .select({ unreadCount: sql<number>`count(*)` })
      .from(chatMessages)
      .innerJoin(
        chatConversations,
        eq(chatMessages.conversationId, chatConversations.id),
      )
      .where(and(
        eq(chatConversations.participant1Id, session.user.id),
        isNull(chatMessages.readAt),
        ne(chatMessages.senderHandle, session.user.handle),
      ));

    return NextResponse.json({ unreadCount: Number(row?.unreadCount || 0) });
  } catch (error) {
    console.error('Get unread chat count error:', error);
    return NextResponse.json({ error: 'Failed to get unread count' }, { status: 500 });
  }
}
