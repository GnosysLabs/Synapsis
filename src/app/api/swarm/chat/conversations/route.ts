/**
 * Swarm Chat Conversations
 * 
 * GET: List all conversations for the current user
 */

import { NextResponse } from 'next/server';
import { db, chatMessages } from '@/db';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { getSession } from '@/lib/auth';
import { E2EE_CHAT_ACTION, E2EE_PROTOCOL_VERSION, e2eeMessageEnvelopeSchema } from '@/lib/e2ee/protocol';

export async function GET() {
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
      orderBy: (chatConversations, { desc }) => [desc(chatConversations.lastMessageAt)],
      with: {
        messages: {
          orderBy: (chatMessages, { desc }) => [desc(chatMessages.createdAt)],
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
                publicKey: profileData.profile.publicKey,
              });

              // Re-query to get the new cached user
              cachedUser = await db.query.users.findFirst({
                where: { handle: participant2Handle },
              });
            }
          } catch (e) {
            console.error(`[Lazy Load] Failed for ${participant2Handle}:`, e);
          }
        }

        if (cachedUser) {
          participant2Info = {
            handle: cachedUser.handle,
            displayName: cachedUser.displayName || cachedUser.handle,
            avatarUrl: cachedUser.avatarUrl || null,
            did: cachedUser.did || '',
          };
        }

        const latest = conv.messages[0] || null;
        let lastMessage: {
          protocolVersion: number;
          content: string | null;
          encryptedEnvelope: unknown;
          signedAction: unknown;
          senderPublicKey: string | null;
        } | null = latest ? {
          protocolVersion: 0,
          content: latest.content,
          encryptedEnvelope: null,
          signedAction: null,
          senderPublicKey: null as string | null,
        } : null;

        if (latest?.protocolVersion === E2EE_PROTOCOL_VERSION && latest.encryptedEnvelope
          && latest.senderDid && latest.e2eeSignature && latest.e2eeActionNonce && latest.e2eeActionTs) {
          try {
            const encryptedEnvelope = e2eeMessageEnvelopeSchema.parse(JSON.parse(latest.encryptedEnvelope));
            const senderPublicKey = latest.senderDid === session.user.did
              ? session.user.publicKey
              : cachedUser?.did === latest.senderDid
                ? cachedUser.publicKey
                : null;
            lastMessage = {
              protocolVersion: E2EE_PROTOCOL_VERSION,
              content: null,
              encryptedEnvelope,
              signedAction: {
                action: E2EE_CHAT_ACTION,
                data: encryptedEnvelope,
                did: latest.senderDid,
                handle: encryptedEnvelope.senderHandle,
                ts: latest.e2eeActionTs,
                nonce: latest.e2eeActionNonce,
                sig: latest.e2eeSignature,
              },
              senderPublicKey,
            };
          } catch (error) {
            console.error(`[E2EE Chat] Invalid conversation preview ${latest.id}:`, error);
            lastMessage = null;
          }
        }

        const { messages: _rawMessages, ...conversation } = conv;
        void _rawMessages;
        return {
          ...conversation,
          participant2: {
            ...participant2Info,
            isBot: cachedUser?.isBot || false,
          },
          lastMessage,
          unreadCount: Number(unreadCount[0]?.count || 0),
        };
      })
    );

    return NextResponse.json({
      conversations: conversationsWithUnread.filter(c => !c.participant2.isBot),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('List conversations error:', error);
    return NextResponse.json({ error: 'Failed to list conversations' }, { status: 500 });
  }
}
