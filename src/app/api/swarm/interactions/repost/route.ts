/**
 * Swarm Repost Endpoint
 * 
 * POST: Receive a repost from another swarm node
 * 
 * SECURITY: All requests must be cryptographically signed by the sender.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, posts, notifications, remoteReposts } from '@/db';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isFreshFederationTimestamp, verifySwarmRequest } from '@/lib/swarm/signature';
import {
  federationMediaUrlSchema,
  localHandleSchema,
  nodeDomainSchema,
} from '@/lib/utils/federation';
import { FederationRequestBodyError, readLimitedJson } from '@/lib/swarm/request-body';
import { claimInboundFederationAction } from '@/lib/swarm/replay';

const swarmRepostSchema = z.object({
  postId: z.string().uuid(),
  repost: z.object({
    actorHandle: localHandleSchema,
    actorDisplayName: z.string().min(1).max(50),
    actorAvatarUrl: federationMediaUrlSchema.optional(),
    actorIsNsfw: z.boolean(),
    actorNodeDomain: nodeDomainSchema,
    repostId: z.string().uuid(),
    interactionId: z.string().uuid(),
    timestamp: z.string().datetime(),
  }),
  signature: z.string().min(1).max(16_384),
});

/**
 * POST /api/swarm/interactions/repost
 * 
 * Receives a repost notification from another swarm node.
 */
export async function POST(request: NextRequest) {
  try {
    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    }

    const body = await readLimitedJson(request);
    const data = swarmRepostSchema.parse(body);
    if (!isFreshFederationTimestamp(data.repost.timestamp)) {
      return NextResponse.json({ error: 'Stale interaction' }, { status: 400 });
    }

    // SECURITY: Verify the signature
    const { signature, ...payload } = data;
    const isValid = await verifySwarmRequest(payload, signature, data.repost.actorNodeDomain);

    if (!isValid) {
      console.warn(`[Swarm] Invalid signature for repost from ${data.repost.actorHandle}@${data.repost.actorNodeDomain}`);
      return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
    }
    if (!await claimInboundFederationAction(
      data.repost.actorNodeDomain,
      'repost',
      data.repost.interactionId,
    )) {
      return NextResponse.json({ success: true, message: 'Interaction already processed' });
    }

    // Find the target post
    const post = await db.query.posts.findFirst({
      where: { id: data.postId },
      with: { author: true },
    });

    if (!post) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    if (post.isRemoved) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    const existingRepost = await db.query.remoteReposts.findFirst({
      where: { AND: [{ postId: data.postId }, { actorHandle: data.repost.actorHandle }, { actorNodeDomain: data.repost.actorNodeDomain }] },
    });

    if (existingRepost) {
      await db.update(remoteReposts)
        .set({
          actorDisplayName: data.repost.actorDisplayName,
          actorAvatarUrl: data.repost.actorAvatarUrl || null,
          actorIsNsfw: data.repost.actorIsNsfw,
        })
        .where(eq(remoteReposts.id, existingRepost.id));
      return NextResponse.json({
        success: true,
        message: 'Repost already recorded',
      });
    }

    // Increment repost count
    await db.update(posts)
      .set({ repostsCount: sql`${posts.repostsCount} + 1` })
      .where(eq(posts.id, data.postId));

    await db.insert(remoteReposts).values({
      postId: data.postId,
      actorHandle: data.repost.actorHandle,
      actorDisplayName: data.repost.actorDisplayName,
      actorAvatarUrl: data.repost.actorAvatarUrl || null,
      actorIsNsfw: data.repost.actorIsNsfw,
      actorNodeDomain: data.repost.actorNodeDomain,
    });

    // Create notification with actor info stored directly
    try {
      await db.insert(notifications).values({
        userId: post.userId,
        actorHandle: data.repost.actorHandle,
        actorDisplayName: data.repost.actorDisplayName,
        actorAvatarUrl: data.repost.actorAvatarUrl || null,
        actorNodeDomain: data.repost.actorNodeDomain,
        postId: data.postId,
        postContent: post.content?.slice(0, 200) || null,
        type: 'repost',
      });
      console.log(`[Swarm] Created repost notification for post ${data.postId} from ${data.repost.actorHandle}@${data.repost.actorNodeDomain}`);
    } catch (notifError) {
      console.error(`[Swarm] Failed to create repost notification:`, notifError);
    }

    console.log(`[Swarm] Received repost from ${data.repost.actorHandle}@${data.repost.actorNodeDomain} on post ${data.postId}`);

    return NextResponse.json({
      success: true,
      message: 'Repost received',
    });
  } catch (error) {
    if (error instanceof FederationRequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request', details: error.issues }, { status: 400 });
    }
    console.error('[Swarm] Repost error:', error);
    return NextResponse.json({ error: 'Failed to process repost' }, { status: 500 });
  }
}
