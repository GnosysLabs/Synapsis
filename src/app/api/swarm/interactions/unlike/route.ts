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
import { verifySwarmRequest } from '@/lib/swarm/signature';
import { localHandleSchema, nodeDomainSchema } from '@/lib/utils/federation';

const swarmUnlikeSchema = z.object({
  postId: z.string().uuid(),
  unlike: z.object({
    actorHandle: localHandleSchema,
    actorNodeDomain: nodeDomainSchema,
    interactionId: z.string().uuid(),
    timestamp: z.string().datetime(),
  }),
  signature: z.string(),
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

    const body = await request.json();
    const data = swarmUnlikeSchema.parse(body);

    // SECURITY: Verify the signature
    const { signature, ...payload } = data;
    const isValid = await verifySwarmRequest(payload, signature, data.unlike.actorNodeDomain);

    if (!isValid) {
      console.warn(`[Swarm] Invalid signature for unlike from ${data.unlike.actorHandle}@${data.unlike.actorNodeDomain}`);
      return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
    }

    // Find the target post
    const post = await db.query.posts.findFirst({
      where: eq(posts.id, data.postId),
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
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request', details: error.issues }, { status: 400 });
    }
    console.error('[Swarm] Unlike error:', error);
    return NextResponse.json({ error: 'Failed to process unlike' }, { status: 500 });
  }
}
