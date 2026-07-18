/**
 * Swarm Unfollow Endpoint
 * 
 * POST: Receive an unfollow from another swarm node
 * 
 * SECURITY: All requests must be cryptographically signed by the sender.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, users, remoteFollowers } from '@/db';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isFreshFederationTimestamp, verifySwarmRequest } from '@/lib/swarm/signature';
import { localHandleSchema, nodeDomainSchema } from '@/lib/utils/federation';
import { FederationRequestBodyError, readLimitedJson } from '@/lib/swarm/request-body';
import { claimInboundFederationAction } from '@/lib/swarm/replay';

const swarmUnfollowSchema = z.object({
  targetHandle: localHandleSchema,
  unfollow: z.object({
    followerHandle: localHandleSchema,
    followerNodeDomain: nodeDomainSchema,
    interactionId: z.string().uuid(),
    timestamp: z.string().datetime(),
  }),
  signature: z.string().min(1).max(16_384),
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

    const body = await readLimitedJson(request);
    const data = swarmUnfollowSchema.parse(body);
    if (!isFreshFederationTimestamp(data.unfollow.timestamp)) {
      return NextResponse.json({ error: 'Stale interaction' }, { status: 400 });
    }

    // SECURITY: Verify the signature
    const { signature, ...payload } = data;
    const isValid = await verifySwarmRequest(payload, signature, data.unfollow.followerNodeDomain);

    if (!isValid) {
      console.warn(`[Swarm] Invalid signature for unfollow from ${data.unfollow.followerHandle}@${data.unfollow.followerNodeDomain}`);
      return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
    }
    if (!await claimInboundFederationAction(
      data.unfollow.followerNodeDomain,
      'unfollow',
      data.unfollow.interactionId,
    )) {
      return NextResponse.json({ success: true, message: 'Interaction already processed' });
    }

    // Find the target user
    const targetUser = await db.query.users.findFirst({
      where: { handle: data.targetHandle.toLowerCase() },
    });

    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Find and remove the remote follower record
    const actorUrl = `swarm://${data.unfollow.followerNodeDomain}/${data.unfollow.followerHandle}`;
    
    const existingFollow = await db.query.remoteFollowers.findFirst({
      where: { AND: [{ userId: targetUser.id }, { actorUrl: actorUrl }] },
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
      .set({ followersCount: sql`max(0, ${users.followersCount} - 1)` })
      .where(eq(users.id, targetUser.id));

    console.log(`[Swarm] Received unfollow from ${data.unfollow.followerHandle}@${data.unfollow.followerNodeDomain} for @${data.targetHandle}`);

    return NextResponse.json({
      success: true,
      message: 'Unfollow received',
    });
  } catch (error) {
    if (error instanceof FederationRequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request', details: error.issues }, { status: 400 });
    }
    console.error('[Swarm] Unfollow error:', error);
    return NextResponse.json({ error: 'Failed to process unfollow' }, { status: 500 });
  }
}
