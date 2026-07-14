/**
 * Swarm Chat Conversations
 * 
 * GET: List all conversations for the current user
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, chatConversations, chatMessages, users } from '@/db';
import { eq, desc, and, isNull, sql } from 'drizzle-orm';
import { getSession } from '@/lib/auth';

export async function GET(request: NextRequest) {
  try {
    if (!db) {
      return NextResponse.json({ conversations: [] });
    }

    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get all conversations for this user
    const conversations = await db.query.chatConversations.findMany({
      where: { participant1Id: session.user.id },
      orderBy: () => [desc(chatConversations.lastMessageAt)],
      with: {
        messages: {
          orderBy: () => [desc(chatMessages.createdAt)],
          limit: 1,
        },
      },
    });

    // Calculate unread count for each conversation
    const conversationsWithUnread = await Promise.all(
      conversations.map(async (conv) => {
        const unreadCount = await db
          .select({ count: sql<number>`count(*)` })
          .from(chatMessages)
          .where(
            and(
              eq(chatMessages.conversationId, conv.id),
              isNull(chatMessages.readAt),
              sql`${chatMessages.senderHandle} != ${session.user.handle}`
            )
          );

        // Parse participant info
        const participant2Handle = conv.participant2Handle;
        const isRemote = participant2Handle.includes('@');

        let participant2Info = {
          handle: participant2Handle,
          displayName: participant2Handle,
          avatarUrl: null as string | null,
          did: '' as string,
        };

        // Try to get cached user info
        let cachedUser = await db.query.users.findFirst({
          where: { handle: participant2Handle },
        });

        // If not found, check if it's a local user with a domain suffix
        if (!cachedUser && participant2Handle.includes('@')) {
          const [handlePart, domainPart] = participant2Handle.split('@');
          if (!domainPart || domainPart === process.env.NEXT_PUBLIC_NODE_DOMAIN) {
            cachedUser = await db.query.users.findFirst({
              where: { handle: handlePart },
            });
          }
        }

        // LAZY LOAD: If remote and (not cached OR missing avatar), try to fetch it now
        if (isRemote && (!cachedUser || !cachedUser.avatarUrl)) {
          try {
            const [rHandle, rDomain] = participant2Handle.split('@');
            const { fetchSwarmUserProfile } = await import('@/lib/swarm/interactions');
            const profileData = await fetchSwarmUserProfile(rHandle, rDomain, 0);

            if (profileData?.profile) {
              const { upsertRemoteUser } = await import('@/lib/swarm/user-cache');
              await upsertRemoteUser({
                handle: participant2Handle,
                displayName: profileData.profile.displayName,
                avatarUrl: profileData.profile.avatarUrl || null,
                did: profileData.profile.did || '',
                isBot: profileData.profile.isBot || false,
              });

              // Re-query to get the new cached user
              cachedUser = await db.query.users.findFirst({
                where: { handle: participant2Handle },
              }) as any;
            }
          } catch (e) {
            console.error(`[Lazy Load] Failed for ${participant2Handle}:`, e);
          }
        }

        if (cachedUser) {
          participant2Info = {
            handle: cachedUser.handle,
            displayName: (cachedUser as any).displayName || cachedUser.handle,
            avatarUrl: (cachedUser as any).avatarUrl || null,
            did: (cachedUser as any).did || '',
          };
        }

        return {
          ...conv,
          participant2: {
            ...participant2Info,
            isBot: (cachedUser as any)?.isBot || false,
          },
          unreadCount: Number(unreadCount[0]?.count || 0),
        };
      })
    );

    return NextResponse.json({
      conversations: conversationsWithUnread.filter(c => !c.participant2.isBot),
    });
  } catch (error) {
    console.error('List conversations error:', error);
    return NextResponse.json({ error: 'Failed to list conversations' }, { status: 500 });
  }
}
