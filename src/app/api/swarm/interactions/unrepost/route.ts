/**
 * Swarm Unrepost Endpoint
 * 
 * POST: Receive an unrepost from another swarm node
 * 
 * SECURITY: All requests must be cryptographically signed by the sender.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, posts, remoteReposts } from '@/db';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isFreshFederationTimestamp, verifySwarmRequest } from '@/lib/swarm/signature';
import { localHandleSchema, nodeDomainSchema } from '@/lib/utils/federation';
import { FederationRequestBodyError, readLimitedJson } from '@/lib/swarm/request-body';
import { claimInboundFederationAction } from '@/lib/swarm/replay';

const swarmUnrepostSchema = z.object({
  postId: z.string().uuid(),
  unrepost: z.object({
    actorHandle: localHandleSchema,
    actorNodeDomain: nodeDomainSchema,
    interactionId: z.string().uuid(),
    timestamp: z.string().datetime(),
  }),
  signature: z.string().min(1).max(16_384),
});

/**
 * POST /api/swarm/interactions/unrepost
 * 
 * Receives an unrepost from another swarm node.
 */
export async function POST(request: NextRequest) {
  try {
    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    }

    const body = await readLimitedJson(request);
    const data = swarmUnrepostSchema.parse(body);
    if (!isFreshFederationTimestamp(data.unrepost.timestamp)) {
      return NextResponse.json({ error: 'Stale interaction' }, { status: 400 });
    }

    // SECURITY: Verify the signature
    const { signature, ...payload } = data;
    const isValid = await verifySwarmRequest(payload, signature, data.unrepost.actorNodeDomain);

    if (!isValid) {
      console.warn(`[Swarm] Invalid signature for unrepost from ${data.unrepost.actorHandle}@${data.unrepost.actorNodeDomain}`);
      return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
    }
    if (!await claimInboundFederationAction(
      data.unrepost.actorNodeDomain,
      'unrepost',
      data.unrepost.interactionId,
    )) {
      return NextResponse.json({ success: true, message: 'Interaction already processed' });
    }

    // Find the target post
    const post = await db.query.posts.findFirst({
      where: { id: data.postId },
    });

    if (!post) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    if (post.isRemoved) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    const existingRepost = await db.query.remoteReposts.findFirst({
      where: { AND: [{ postId: data.postId }, { actorHandle: data.unrepost.actorHandle }, { actorNodeDomain: data.unrepost.actorNodeDomain }] },
    });

    if (!existingRepost) {
      return NextResponse.json({
        success: true,
        message: 'Repost already removed',
      });
    }

    // Decrement repost count
    await db.update(posts)
      .set({ repostsCount: sql`max(0, ${posts.repostsCount} - 1)` })
      .where(eq(posts.id, data.postId));

    await db.delete(remoteReposts).where(eq(remoteReposts.id, existingRepost.id));

    console.log(`[Swarm] Received unrepost from ${data.unrepost.actorHandle}@${data.unrepost.actorNodeDomain} on post ${data.postId}`);

    return NextResponse.json({
      success: true,
      message: 'Unrepost received',
    });
  } catch (error) {
    if (error instanceof FederationRequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request', details: error.issues }, { status: 400 });
    }
    console.error('[Swarm] Unrepost error:', error);
    return NextResponse.json({ error: 'Failed to process unrepost' }, { status: 500 });
  }
}
