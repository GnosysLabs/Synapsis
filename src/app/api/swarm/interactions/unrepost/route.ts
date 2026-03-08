/**
 * Swarm Unrepost Endpoint
 * 
 * POST: Receive an unrepost from another swarm node
 * 
 * SECURITY: All requests must be cryptographically signed by the sender.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, posts } from '@/db';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { verifyUserInteraction } from '@/lib/swarm/signature';
import { localHandleSchema, nodeDomainSchema } from '@/lib/utils/federation';

const swarmUnrepostSchema = z.object({
  postId: z.string().uuid(),
  unrepost: z.object({
    actorHandle: localHandleSchema,
    actorNodeDomain: nodeDomainSchema,
    interactionId: z.string().uuid(),
    timestamp: z.string().datetime(),
  }),
  signature: z.string(),
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

    const body = await request.json();
    const data = swarmUnrepostSchema.parse(body);

    // SECURITY: Verify the signature
    const { signature, ...payload } = data;
    const isValid = await verifyUserInteraction(
      payload,
      signature,
      data.unrepost.actorHandle,
      data.unrepost.actorNodeDomain
    );

    if (!isValid) {
      console.warn(`[Swarm] Invalid signature for unrepost from ${data.unrepost.actorHandle}@${data.unrepost.actorNodeDomain}`);
      return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
    }

    // Find the target post
    const post = await db.query.posts.findFirst({
      where: eq(posts.id, data.postId),
    });

    if (!post) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    if (post.isRemoved) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    // Decrement repost count
    await db.update(posts)
      .set({ repostsCount: sql`GREATEST(0, ${posts.repostsCount} - 1)` })
      .where(eq(posts.id, data.postId));

    console.log(`[Swarm] Received unrepost from ${data.unrepost.actorHandle}@${data.unrepost.actorNodeDomain} on post ${data.postId}`);

    return NextResponse.json({
      success: true,
      message: 'Unrepost received',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request', details: error.issues }, { status: 400 });
    }
    console.error('[Swarm] Unrepost error:', error);
    return NextResponse.json({ error: 'Failed to process unrepost' }, { status: 500 });
  }
}
