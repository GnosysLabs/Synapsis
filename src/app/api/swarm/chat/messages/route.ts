/**
 * Swarm Chat Messages
 * 
 * GET: Get messages for a conversation
 * PATCH: Mark messages as read
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, chatMessages, users } from '@/db';
import { eq, and, isNull } from 'drizzle-orm';
import { getSession } from '@/lib/auth';
import { z } from 'zod';
import { E2EE_CHAT_ACTION, E2EE_PROTOCOL_VERSION, e2eeMessageEnvelopeSchema } from '@/lib/e2ee/protocol';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { shouldIncludeNsfwFeed } from '@/lib/nsfw/feed-access';
import { redactSensitiveUserSummary } from '@/lib/nsfw/content-visibility';

// Schema for query parameters
const messagesQuerySchema = z.object({
    conversationId: z.string().uuid(),
    cursor: z.string().datetime().optional(),
    limit: z.number().min(1).max(100).default(50),
});

// Schema for PATCH request body
const markReadSchema = z.object({
    conversationId: z.string().uuid(),
});

type ChatUser = typeof users.$inferSelect;


export async function GET(request: NextRequest) {
  try {
    if (!db) {
      return NextResponse.json({ messages: [] });
    }

    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const localNodeIsNsfw = await requireLocalNodeNsfwClassification();
    const canViewSensitive = shouldIncludeNsfwFeed({
      viewer: session.user,
      localNodeIsNsfw,
    });

    const { searchParams } = new URL(request.url);
    
    // Validate query parameters
    const queryResult = messagesQuerySchema.safeParse({
      conversationId: searchParams.get('conversationId'),
      cursor: searchParams.get('cursor') || undefined,
      limit: parseInt(searchParams.get('limit') || '50'),
    });

    if (!queryResult.success) {
      return NextResponse.json({ error: 'Invalid query parameters', details: queryResult.error.issues }, { status: 400 });
    }

    const { conversationId, cursor, limit } = queryResult.data;

    // Verify user has access to this conversation
    const conversation = await db.query.chatConversations.findFirst({
      where: { AND: [{ id: conversationId }, { participant1Id: session.user.id }] },
    });

    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    // Build query with cursor-based pagination
    const whereCondition = cursor
      ? { conversationId, createdAt: { lt: new Date(cursor) } }
      : { conversationId };

    // Get messages
    const messages = await db.query.chatMessages.findMany({
      where: whereCondition,
      orderBy: (chatMessages, { desc }) => [desc(chatMessages.createdAt)],
      limit,
    });



    // Collect all unique sender DIDs/Handles
    const senderDids = new Set<string>();
    const senderHandles = new Set<string>(); // Fallback

    messages.forEach(m => {
      if (m.senderDid) senderDids.add(m.senderDid);
      else if (m.senderHandle) senderHandles.add(m.senderHandle);
    });

    // Fetch users
    const usersByDid: Record<string, ChatUser> = {};
    const usersByHandle: Record<string, ChatUser> = {};

    if (senderDids.size > 0) {
      const found = await db.query.users.findMany({
        where: { did: { in: Array.from(senderDids) } }
      });
      found.forEach(u => usersByDid[u.did] = u);
    }

    // Also fetch local users by handle if needed
    if (senderHandles.size > 0) {
      const found = await db.query.users.findMany({
        where: { handle: { in: Array.from(senderHandles) } }
      });
      found.forEach(u => usersByHandle[u.handle] = u);
    }

    const messagesMapped = messages.map((msg) => {
      const isSentByMe = msg.senderDid === session.user.did || msg.senderHandle === session.user.handle;

      // Resolve fresh user data
      const user = msg.senderDid ? usersByDid[msg.senderDid] : usersByHandle[msg.senderHandle];

      const displayName = user?.displayName || msg.senderDisplayName || msg.senderHandle;
      const avatarUrl = user?.avatarUrl || msg.senderAvatarUrl;
      const senderDomain = msg.senderNodeDomain || (
        msg.senderHandle.includes('@') ? msg.senderHandle.split('@').pop() || null : null
      );
      const localDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || process.env.NODE_DOMAIN || 'localhost:43821';
      const senderIsRemote = Boolean(senderDomain && senderDomain !== localDomain);
      // Imported and historical messages may outlive their sender row. Stored
      // avatar snapshots have no trustworthy classifier, so fail closed unless
      // this is the authenticated viewer's own message.
      const senderClassifierMissing = !user && !isSentByMe;
      const senderProfile = redactSensitiveUserSummary({
        handle: msg.senderHandle,
        displayName,
        avatarUrl,
        isRemote: senderIsRemote || senderClassifierMissing,
        nodeDomain: senderDomain,
        isNsfw: senderIsRemote
          ? user?.isNsfw === true ? true : undefined
          : user?.isNsfw ?? (isSentByMe ? session.user.isNsfw : undefined),
        nodeIsNsfw: senderIsRemote || senderClassifierMissing ? undefined : localNodeIsNsfw,
      }, canViewSensitive);

      let encryptedEnvelope = null;
      let signedAction = null;
      if (msg.protocolVersion === E2EE_PROTOCOL_VERSION && msg.encryptedEnvelope) {
        try {
          encryptedEnvelope = e2eeMessageEnvelopeSchema.parse(JSON.parse(msg.encryptedEnvelope));
          if (!msg.senderDid || !msg.e2eeSignature || !msg.e2eeActionNonce || !msg.e2eeActionTs) {
            throw new Error('Encrypted message signature metadata is incomplete');
          }
          signedAction = {
            action: E2EE_CHAT_ACTION,
            data: encryptedEnvelope,
            did: msg.senderDid,
            handle: encryptedEnvelope.senderHandle,
            ts: msg.e2eeActionTs,
            nonce: msg.e2eeActionNonce,
            sig: msg.e2eeSignature,
          };
        } catch (error) {
          console.error(`[E2EE Chat] Invalid stored envelope ${msg.id}:`, error);
        }
      }

      return {
        id: msg.id,
        clientMessageId: msg.clientMessageId,
        senderHandle: msg.senderHandle,
        senderDisplayName: senderProfile.displayName,
        senderAvatarUrl: senderProfile.avatarUrl,
        senderNodeDomain: senderProfile.nodeDomain,
        senderIsNsfw: senderProfile.isNsfw,
        senderNodeIsNsfw: senderProfile.nodeIsNsfw,
        senderDid: msg.senderDid,
        content: msg.protocolVersion === 0 ? msg.content : null,
        protocolVersion: msg.protocolVersion,
        encryptedEnvelope,
        signedAction,
        senderPublicKey: user?.publicKey || null,
        deliveredAt: msg.deliveredAt,
        readAt: msg.readAt,
        createdAt: msg.createdAt,
        isSentByMe,
      };
    });

    return NextResponse.json({
      messages: messagesMapped.reverse(), // Oldest first for display
      nextCursor: messages.length === limit ? messages[messages.length - 1].createdAt.toISOString() : null,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid input', details: error.issues }, { status: 400 });
    }
    console.error('Get messages error:', error);
    return NextResponse.json({ error: 'Failed to get messages' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    }

    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    
    // Validate request body
    const bodyResult = markReadSchema.safeParse(body);
    if (!bodyResult.success) {
      return NextResponse.json({ error: 'Invalid request body', details: bodyResult.error.issues }, { status: 400 });
    }
    
    const { conversationId } = bodyResult.data;

    // Verify user has access to this conversation
    const conversation = await db.query.chatConversations.findFirst({
      where: { AND: [{ id: conversationId }, { participant1Id: session.user.id }] },
    });

    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    // Mark all unread messages as read
    await db.update(chatMessages)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(chatMessages.conversationId, conversationId),
          isNull(chatMessages.readAt)
        )
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid input', details: error.issues }, { status: 400 });
    }
    console.error('Mark as read error:', error);
    return NextResponse.json({ error: 'Failed to mark as read' }, { status: 500 });
  }
}
