/**
 * Swarm Chat Conversations
 * 
 * GET: List all conversations for the current user
 */

import { NextResponse } from 'next/server';
import { db, chatMessages, users } from '@/db';
import { and, inArray, isNull, ne, or, sql } from 'drizzle-orm';
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
    });

    const conversationIds = conversations.map((conversation) => conversation.id);
    const participantLookupHandles = new Set<string>();
    const latestSenderDids = new Set<string>();
    const localNodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN;
    for (const conversation of conversations) {
      const participantHandle = conversation.participant2Handle;
      participantLookupHandles.add(participantHandle);
      const separator = participantHandle.lastIndexOf('@');
      if (separator > 0 && participantHandle.slice(separator + 1) === localNodeDomain) {
        participantLookupHandles.add(participantHandle.slice(0, separator));
      }
    }

    // The inbox must be local-data-only. The previous implementation issued an
    // unread query, a user query, and potentially an outbound federation request
    // for every row. A single unavailable peer could therefore block the entire
    // response. Batch local metadata here; independent federation paths refresh
    // the remote-user cache without being on the inbox critical path.
    const [unreadRows, latestMessages] = await Promise.all([
      conversationIds.length > 0
        ? db
          .select({
            conversationId: chatMessages.conversationId,
            count: sql<number>`count(*)`,
          })
          .from(chatMessages)
          .where(and(
            inArray(chatMessages.conversationId, conversationIds),
            isNull(chatMessages.readAt),
            ne(chatMessages.senderHandle, session.user.handle),
          ))
          .groupBy(chatMessages.conversationId)
        : Promise.resolve([]),
      conversationIds.length > 0
        ? db
          .select()
          .from(chatMessages)
          .where(and(
            inArray(chatMessages.conversationId, conversationIds),
            sql`${chatMessages.id} = (
              SELECT latest.id
              FROM chat_messages AS latest
              WHERE latest.conversation_id = ${chatMessages.conversationId}
              ORDER BY latest.created_at DESC, latest.rowid DESC
              LIMIT 1
            )`,
          ))
        : Promise.resolve([]),
    ]);

    const latestByConversation = new Map(
      latestMessages.map((message) => [message.conversationId, message]),
    );
    for (const message of latestMessages) {
      if (message.senderDid) latestSenderDids.add(message.senderDid);
    }

    const cachedUsers = participantLookupHandles.size > 0
      ? await db
        .select({
          handle: users.handle,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
          did: users.did,
          publicKey: users.publicKey,
        })
        .from(users)
        .where(latestSenderDids.size > 0
          ? or(
              inArray(users.handle, [...participantLookupHandles]),
              inArray(users.did, [...latestSenderDids]),
            )
          : inArray(users.handle, [...participantLookupHandles]))
      : [];

    const unreadByConversation = new Map(
      unreadRows.map((row) => [row.conversationId, Number(row.count || 0)]),
    );
    const usersByHandle = new Map(cachedUsers.map((user) => [user.handle, user]));
    const usersByDid = new Map(cachedUsers.map((user) => [user.did, user]));

    const conversationsWithUnread = conversations.map((conv) => {
        const participant2Handle = conv.participant2Handle;
        const separator = participant2Handle.lastIndexOf('@');
        const localHandle = separator > 0
          && participant2Handle.slice(separator + 1) === localNodeDomain
          ? participant2Handle.slice(0, separator)
          : null;
        const cachedUser = usersByHandle.get(participant2Handle)
          || (localHandle ? usersByHandle.get(localHandle) : undefined);
        const participant2Info = cachedUser
          ? {
              handle: cachedUser.handle,
              displayName: cachedUser.displayName || cachedUser.handle,
              avatarUrl: cachedUser.avatarUrl || null,
              did: cachedUser.did || '',
            }
          : {
              handle: participant2Handle,
              displayName: participant2Handle,
              avatarUrl: null as string | null,
              did: '',
            };

        const latest = latestByConversation.get(conv.id) || null;
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
            // The sender is cryptographically identified by DID. Do not infer
            // their signing key from the conversation partner's cached handle:
            // federated handles can be qualified, normalized, or stale aliases.
            const senderUser = usersByDid.get(latest.senderDid);
            const senderPublicKey = latest.senderDid === session.user.did
              ? session.user.publicKey
              : senderUser?.publicKey || null;
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

        return {
          ...conv,
          participant2: participant2Info,
          lastMessage,
          unreadCount: unreadByConversation.get(conv.id) || 0,
        };
      });

    return NextResponse.json({
      conversations: conversationsWithUnread,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('List conversations error:', error);
    return NextResponse.json({ error: 'Failed to list conversations' }, { status: 500 });
  }
}
