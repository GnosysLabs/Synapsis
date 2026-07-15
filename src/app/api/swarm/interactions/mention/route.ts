/**
 * Swarm Mention Endpoint
 * 
 * POST: Receive a mention notification from another swarm node
 * 
 * SECURITY: All requests must be cryptographically signed by the sender.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, notifications } from '@/db';
import { z } from 'zod';
import { verifySwarmRequest } from '@/lib/swarm/signature';
import { localHandleSchema, nodeDomainSchema } from '@/lib/utils/federation';
import { buildNotificationTarget } from '@/lib/notifications';
import { normalizeNodeDomain } from '@/lib/swarm/node-domain';

const swarmMentionSchema = z.object({
  mentionedHandle: localHandleSchema,
  mention: z.object({
    actorHandle: localHandleSchema,
    actorDisplayName: z.string().min(1).max(50),
    actorAvatarUrl: z.string().url().optional(),
    actorNodeDomain: nodeDomainSchema,
    actorDid: z.string().min(1).max(500).optional(),
    actorPublicKey: z.string().min(1).max(5000).optional(),
    postId: z.string().uuid(),
    postContent: z.string().max(10000),
    interactionId: z.string().uuid(),
    timestamp: z.string().datetime(),
  }),
  signature: z.string(),
});

async function acceptsRemoteMention(
  userId: string,
  actorDomain: string,
  cachedActorId: string | null,
): Promise<boolean> {
  const nodeMute = await db.query.mutedNodes.findFirst({
    where: { AND: [{ userId }, { nodeDomain: actorDomain }] },
    columns: { id: true },
  });
  if (nodeMute) return false;
  if (!cachedActorId) return true;

  const [block, mute] = await Promise.all([
    db.query.blocks.findFirst({
      where: {
        OR: [
          { AND: [{ userId }, { blockedUserId: cachedActorId }] },
          { AND: [{ userId: cachedActorId }, { blockedUserId: userId }] },
        ],
      },
      columns: { id: true },
    }),
    db.query.mutes.findFirst({
      where: { AND: [{ userId }, { mutedUserId: cachedActorId }] },
      columns: { id: true },
    }),
  ]);
  return !block && !mute;
}

/**
 * POST /api/swarm/interactions/mention
 * 
 * Receives a mention notification from another swarm node.
 */
export async function POST(request: NextRequest) {
  try {
    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    }

    const body = await request.json();
    const data = swarmMentionSchema.parse(body);

    // SECURITY: Verify the signature
    const { signature, ...payload } = data;
    const isValid = await verifySwarmRequest(payload, signature, data.mention.actorNodeDomain);

    if (!isValid) {
      console.warn(`[Swarm] Invalid signature for mention from ${data.mention.actorHandle}@${data.mention.actorNodeDomain}`);
      return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
    }

    // Find the mentioned user (local user)
    const mentionedUser = await db.query.users.findFirst({
      where: { handle: data.mentionedHandle.toLowerCase() },
    });

    if (!mentionedUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (mentionedUser.isSuspended) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const actorDomain = normalizeNodeDomain(data.mention.actorNodeDomain);
    const interactionKey = `mention:remote:${actorDomain}:${data.mention.interactionId}`;
    const cachedActor = await db.query.users.findFirst({
      where: { handle: `${data.mention.actorHandle.toLowerCase()}@${actorDomain}` },
      columns: { id: true },
    });
    if (!(await acceptsRemoteMention(mentionedUser.id, actorDomain, cachedActor?.id || null))) {
      // Do not disclose moderation state to the sending node.
      return NextResponse.json({ success: true, message: 'Mention received' });
    }

    // The interaction ID is persisted under a unique index. A retried signed
    // request therefore remains successful without creating duplicates.
    const inserted = await db.insert(notifications).values({
        userId: mentionedUser.id,
        actorHandle: data.mention.actorHandle,
        actorDisplayName: data.mention.actorDisplayName,
        actorAvatarUrl: data.mention.actorAvatarUrl || null,
        actorNodeDomain: actorDomain,
        remotePostId: data.mention.postId,
        remotePostDomain: actorDomain,
        postContent: data.mention.postContent.slice(0, 200),
        interactionId: interactionKey,
        ...(mentionedUser.isBot ? buildNotificationTarget(mentionedUser) : {}),
        type: 'mention',
      }).onConflictDoNothing().returning({ id: notifications.id });
    if (inserted.length > 0) {
      console.log(`[Swarm] Created mention notification for @${data.mentionedHandle} from ${data.mention.actorHandle}@${data.mention.actorNodeDomain}`);
    }

    // Also notify bot owner if this is a bot being mentioned
    if (mentionedUser.isBot
      && mentionedUser.botOwnerId
      && await acceptsRemoteMention(mentionedUser.botOwnerId, actorDomain, cachedActor?.id || null)) {
        await db.insert(notifications).values({
          userId: mentionedUser.botOwnerId,
          actorHandle: data.mention.actorHandle,
          actorDisplayName: data.mention.actorDisplayName,
          actorAvatarUrl: data.mention.actorAvatarUrl || null,
          actorNodeDomain: actorDomain,
          remotePostId: data.mention.postId,
          remotePostDomain: actorDomain,
          postContent: data.mention.postContent.slice(0, 200),
          interactionId: `${interactionKey}:owner:${mentionedUser.id}`,
          ...buildNotificationTarget(mentionedUser),
          type: 'mention',
        }).onConflictDoNothing();
    }

    console.log(`[Swarm] Received mention from ${data.mention.actorHandle}@${data.mention.actorNodeDomain} for @${data.mentionedHandle}`);

    return NextResponse.json({
      success: true,
      message: 'Mention received',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request', details: error.issues }, { status: 400 });
    }
    console.error('[Swarm] Mention error:', error);
    return NextResponse.json({ error: 'Failed to process mention' }, { status: 500 });
  }
}
