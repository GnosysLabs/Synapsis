/**
 * Swarm Unfollow Endpoint
 * 
 * POST: Receive an unfollow from another swarm node
 * 
 * SECURITY: All requests must be cryptographically signed by the sender.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, users, remoteFollowers } from '@/db';
import { eq, and, sql } from 'drizzle-orm';
import { z } from 'zod';
import { verifySwarmRequest } from '@/lib/swarm/signature';
import { localHandleSchema, nodeDomainSchema } from '@/lib/utils/federation';

const swarmUnfollowSchema = z.object({
  targetHandle: localHandleSchema,
  unfollow: z.object({
    followerHandle: localHandleSchema,
    followerNodeDomain: nodeDomainSchema,
    interactionId: z.string().uuid(),
    timestamp: z.string().datetime(),
  }),
  signature: z.string(),
});

/**
 * POST /api/swarm/interactions/unfollow
 * 
 * Receives an unfollow from another swarm node.
 */
export async function POST(request: NextRequest) {
  try {
    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    }

    const body = await request.json();
    const data = swarmUnfollowSchema.parse(body);

    // SECURITY: Verify the signature
    const { signature, ...payload } = data;
    const isValid = await verifySwarmRequest(payload, signature, data.unfollow.followerNodeDomain);

    if (!isValid) {
      console.warn(`[Swarm] Invalid signature for unfollow from ${data.unfollow.followerHandle}@${data.unfollow.followerNodeDomain}`);
      return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
    }

    // Find the target user
    const targetUser = await db.query.users.findFirst({
      where: eq(users.handle, data.targetHandle.toLowerCase()),
    });

    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Find and remove the remote follower record
    const actorUrl = `swarm://${data.unfollow.followerNodeDomain}/${data.unfollow.followerHandle}`;
    
    const existingFollow = await db.query.remoteFollowers.findFirst({
      where: and(
        eq(remoteFollowers.userId, targetUser.id),
        eq(remoteFollowers.actorUrl, actorUrl)
      ),
    });

    if (!existingFollow) {
      return NextResponse.json({
        success: true,
        message: 'Not following',
      });
    }

    // Remove the follow
    await db.delete(remoteFollowers).where(eq(remoteFollowers.id, existingFollow.id));

    // Update follower count
    await db.update(users)
      .set({ followersCount: sql`GREATEST(0, ${users.followersCount} - 1)` })
      .where(eq(users.id, targetUser.id));

    console.log(`[Swarm] Received unfollow from ${data.unfollow.followerHandle}@${data.unfollow.followerNodeDomain} for @${data.targetHandle}`);

    return NextResponse.json({
      success: true,
      message: 'Unfollow received',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request', details: error.issues }, { status: 400 });
    }
    console.error('[Swarm] Unfollow error:', error);
    return NextResponse.json({ error: 'Failed to process unfollow' }, { status: 500 });
  }
}
