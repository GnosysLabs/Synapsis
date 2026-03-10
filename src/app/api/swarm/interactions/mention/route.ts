/**
 * Swarm Mention Endpoint
 * 
 * POST: Receive a mention notification from another swarm node
 * 
 * SECURITY: All requests must be cryptographically signed by the sender.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, users, notifications } from '@/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { verifySwarmRequest } from '@/lib/swarm/signature';
import { localHandleSchema, nodeDomainSchema } from '@/lib/utils/federation';
import { buildNotificationTarget } from '@/lib/notifications';

const swarmMentionSchema = z.object({
  mentionedHandle: localHandleSchema,
  mention: z.object({
    actorHandle: localHandleSchema,
    actorDisplayName: z.string().min(1).max(50),
    actorAvatarUrl: z.string().url().optional(),
    actorNodeDomain: nodeDomainSchema,
    postId: z.string().uuid(),
    postContent: z.string().max(10000),
    interactionId: z.string().uuid(),
    timestamp: z.string().datetime(),
  }),
  signature: z.string(),
});

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
      where: eq(users.handle, data.mentionedHandle.toLowerCase()),
    });

    if (!mentionedUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (mentionedUser.isSuspended) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Create notification with actor info stored directly
    try {
      await db.insert(notifications).values({
        userId: mentionedUser.id,
        actorHandle: data.mention.actorHandle,
        actorDisplayName: data.mention.actorDisplayName,
        actorAvatarUrl: data.mention.actorAvatarUrl || null,
        actorNodeDomain: data.mention.actorNodeDomain,
        postContent: data.mention.postContent.slice(0, 200),
        ...(mentionedUser.isBot ? buildNotificationTarget(mentionedUser) : {}),
        type: 'mention',
      });
      console.log(`[Swarm] Created mention notification for @${data.mentionedHandle} from ${data.mention.actorHandle}@${data.mention.actorNodeDomain}`);
    } catch (notifError) {
      console.error(`[Swarm] Failed to create mention notification:`, notifError);
    }

    // Also notify bot owner if this is a bot being mentioned
    if (mentionedUser.isBot && mentionedUser.botOwnerId) {
      try {
        await db.insert(notifications).values({
          userId: mentionedUser.botOwnerId,
          actorHandle: data.mention.actorHandle,
          actorDisplayName: data.mention.actorDisplayName,
          actorAvatarUrl: data.mention.actorAvatarUrl || null,
          actorNodeDomain: data.mention.actorNodeDomain,
          postContent: data.mention.postContent.slice(0, 200),
          ...buildNotificationTarget(mentionedUser),
          type: 'mention',
        });
      } catch (err) {
        console.error('[Swarm] Failed to notify bot owner:', err);
      }
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
