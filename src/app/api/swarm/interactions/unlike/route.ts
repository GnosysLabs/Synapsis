/**
 * Swarm Unlike Endpoint
 * 
 * POST: Receive an unlike from another swarm node
 * 
 * SECURITY: All requests must be cryptographically signed by the sender.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, posts, remoteLikes } from '@/db';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { isFreshFederationTimestamp, verifySwarmRequest } from '@/lib/swarm/signature';
import { localHandleSchema, nodeDomainSchema } from '@/lib/utils/federation';
import { FederationRequestBodyError, readLimitedJson } from '@/lib/swarm/request-body';
import { claimInboundFederationAction } from '@/lib/swarm/replay';

const swarmUnlikeSchema = z.object({
  postId: z.string().uuid(),
  unlike: z.object({
    actorHandle: localHandleSchema,
    actorNodeDomain: nodeDomainSchema,
    interactionId: z.string().uuid(),
    timestamp: z.string().datetime(),
  }),
  signature: z.string().min(1).max(16_384),
});

/**
 * POST /api/swarm/interactions/unlike
 * 
 * Receives an unlike from another swarm node.
 */
export async function POST(request: NextRequest) {
  try {
    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    }

    const body = await readLimitedJson(request);
    const data = swarmUnlikeSchema.parse(body);
    if (!isFreshFederationTimestamp(data.unlike.timestamp)) {
      return NextResponse.json({ error: 'Stale interaction' }, { status: 400 });
    }

    // SECURITY: Verify the signature
    const { signature, ...payload } = data;
    const isValid = await verifySwarmRequest(payload, signature, data.unlike.actorNodeDomain);

    if (!isValid) {
      console.warn(`[Swarm] Invalid signature for unlike from ${data.unlike.actorHandle}@${data.unlike.actorNodeDomain}`);
      return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
    }
    if (!await claimInboundFederationAction(
      data.unlike.actorNodeDomain,
      'unlike',
      data.unlike.interactionId,
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

    // Remove the remote like record
    const deleted = await db.delete(remoteLikes)
      .where(and(
        eq(remoteLikes.postId, data.postId),
        eq(remoteLikes.actorHandle, data.unlike.actorHandle),
        eq(remoteLikes.actorNodeDomain, data.unlike.actorNodeDomain)
      ))
      .returning();

    // Only decrement if we actually had a like record
    if (deleted.length > 0) {
      await db.update(posts)
        .set({ likesCount: Math.max(0, post.likesCount - 1) })
        .where(eq(posts.id, data.postId));
    }

    console.log(`[Swarm] Received unlike from ${data.unlike.actorHandle}@${data.unlike.actorNodeDomain} on post ${data.postId}`);

    return NextResponse.json({
      success: true,
      message: 'Unlike received',
    });
  } catch (error) {
    if (error instanceof FederationRequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request', details: error.issues }, { status: 400 });
    }
    console.error('[Swarm] Unlike error:', error);
    return NextResponse.json({ error: 'Failed to process unlike' }, { status: 500 });
  }
}
