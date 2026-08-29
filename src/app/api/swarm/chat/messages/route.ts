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
import {
  canonicalAccountHomeDomain,
  requireCanonicalAccountHomeDomain,
  resolveAccountAddress,
} from '@/lib/identity/account-address';
import { getBlockedNodeDomains } from '@/lib/swarm/node-blocklist';
import { storedProfilePresentation } from '@/lib/profile/stored-presentation';
import { getKnownSwarmNodeNsfwByDomain } from '@/lib/swarm/registry';

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
      // Stabilize ordering when multiple messages share the same createdAt.
      // Use a deterministic secondary sort key to avoid pagination gaps/dupes.
      orderBy: (chatMessages, { desc }) => [desc(chatMessages.createdAt), desc(chatMessages.id)],
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

    const localDomain = requireCanonicalAccountHomeDomain(
      process.env.NEXT_PUBLIC_NODE_DOMAIN || process.env.NODE_DOMAIN || 'localhost:43821',
    );
    const blockedNodeDomains = new Set(
      [...await getBlockedNodeDomains()]
        .map(canonicalAccountHomeDomain)
        .filter((domain): domain is string => Boolean(domain)),
    );
    const senderNodeDomains = new Set(messages.flatMap((message) => {
      const address = resolveAccountAddress(
        message.senderHandle,
        message.senderNodeDomain || localDomain,
      );
      return address && address.homeDomain !== localDomain ? [address.homeDomain] : [];
    }));
    const nodeNsfwByDomain = await getKnownSwarmNodeNsfwByDomain(senderNodeDomains);

    const messagesMapped = messages.map((msg) => {
      const isSentByMe = msg.senderDid === session.user.did || msg.senderHandle === session.user.handle;

      // Resolve fresh user data
      const user = msg.senderDid ? usersByDid[msg.senderDid] : usersByHandle[msg.senderHandle];

      const senderAddress = resolveAccountAddress(
        msg.senderHandle,
        msg.senderNodeDomain || localDomain,
      );
      const canonicalSenderHandle = senderAddress?.canonical || msg.senderHandle;
      const senderDomain = senderAddress?.homeDomain
        || canonicalAccountHomeDomain(user?.homeDomain)
        || null;
      const senderIsRemote = user
        ? !user.isLocalAccount
        : Boolean(senderDomain && senderDomain !== localDomain);
      const senderNodeBlocked = Boolean(
        senderDomain
        && senderDomain !== localDomain
        && blockedNodeDomains.has(senderDomain),
      );
      // Imported and historical messages may outlive their sender row. Stored
      // avatar snapshots have no trustworthy classifier, so fail closed unless
      // this is the authenticated viewer's own message.
      const senderClassifierMissing = !user && !isSentByMe;
      const senderProfile = (user
        ? storedProfilePresentation(user, {
            localNodeDomain: localDomain,
            localNodeIsNsfw,
            canViewSensitive,
            remoteNodeIsNsfw: senderDomain
              ? nodeNsfwByDomain.get(senderDomain)
              : undefined,
          })
        : null) ?? redactSensitiveUserSummary({
          handle: canonicalSenderHandle,
          displayName: senderAddress?.username || canonicalSenderHandle,
          avatarUrl: null as string | null,
          isRemote: senderIsRemote || senderClassifierMissing,
          nodeDomain: senderDomain,
          isNsfw: isSentByMe ? session.user.isNsfw : undefined,
          nodeIsNsfw: senderIsRemote || senderClassifierMissing ? undefined : localNodeIsNsfw,
          profilePresentationVerified: isSentByMe,
          profileVersion: null as number | null,
          stuffboxBadge: null,
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
        senderHandle: canonicalSenderHandle,
        senderDisplayName: senderNodeBlocked ? canonicalSenderHandle : senderProfile.displayName,
        senderAvatarUrl: senderNodeBlocked ? null : senderProfile.avatarUrl,
        senderNodeDomain: senderDomain,
        senderNodeBlocked,
        senderIsNsfw: senderProfile.isNsfw,
        senderNodeIsNsfw: senderProfile.nodeIsNsfw,
        senderProfilePresentationVerified: senderProfile.profilePresentationVerified,
        senderProfileVersion: senderProfile.profileVersion,
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
