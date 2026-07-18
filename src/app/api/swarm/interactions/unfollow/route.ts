import { NextRequest, NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db, remoteFollowers, swarmInboundActions, users } from '@/db';
import { signedUserActionSchema } from '@/lib/e2ee/protocol';
import {
  FederatedIdentityContinuityError,
  federatedActionFailureInit,
  federationActionContextSchema,
  federationActionDomain,
  pinVerifiedFederatedActorIdentity,
  verifyFederatedUserAction,
} from '@/lib/swarm/federated-action';
import { hasStrictLocalUserOrigin } from '@/lib/swarm/local-user-origin';
import { applyOrderedFederatedRelationshipState } from '@/lib/swarm/relationship-ordering';
import { FederationRequestBodyError, readLimitedJson } from '@/lib/swarm/request-body';
import { isFreshFederationTimestamp } from '@/lib/swarm/signature';
import { localHandleSchema, nodeDomainSchema } from '@/lib/utils/federation';

const PATH = '/api/swarm/interactions/unfollow' as const;

const swarmUnfollowSchema = z.strictObject({
  federation: federationActionContextSchema,
  userAction: signedUserActionSchema,
  targetHandle: localHandleSchema,
  unfollow: z.strictObject({
    followerHandle: localHandleSchema,
    followerNodeDomain: nodeDomainSchema,
    interactionId: z.string().uuid(),
    timestamp: z.string().datetime(),
  }),
  signature: z.string().min(1).max(16_384),
});

const unfollowActionDataSchema = z.strictObject({ targetHandle: z.string().min(3).max(320) });

export async function POST(request: NextRequest) {
  try {
    const data = swarmUnfollowSchema.parse(await readLimitedJson(request));
    if (!isFreshFederationTimestamp(data.unfollow.timestamp)) {
      return NextResponse.json({ error: 'Stale interaction' }, { status: 400 });
    }

    const actorDomain = federationActionDomain(data.unfollow.followerNodeDomain);
    if (!actorDomain) {
      return NextResponse.json({ error: 'Invalid source node' }, { status: 400 });
    }
    const { signature, ...payload } = data;
    const verified = await verifyFederatedUserAction({
      payload,
      nodeSignature: signature,
      sourceDomain: actorDomain,
      expectedMethod: 'POST',
      expectedPath: PATH,
      expectedAction: 'unfollow',
      actorHandle: data.unfollow.followerHandle,
      replayBinding: { targetHandle: data.targetHandle.toLowerCase() },
      maxActionsPerMinute: 30,
    });
    if (!verified.ok) {
      return NextResponse.json({ error: verified.error }, federatedActionFailureInit(verified));
    }

    const targetHandle = data.targetHandle.toLowerCase();
    const actionData = unfollowActionDataSchema.safeParse(verified.userAction.data);
    if (!actionData.success
      || actionData.data.targetHandle.toLowerCase()
        !== `${targetHandle}@${verified.destinationDomain}`) {
      return NextResponse.json({ error: 'Unfollow target is not user-authorized' }, { status: 403 });
    }
    const targetUser = await db.query.users.findFirst({ where: { handle: targetHandle } });
    if (!targetUser || !hasStrictLocalUserOrigin(targetUser)) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    await pinVerifiedFederatedActorIdentity({
      sourceDomain: verified.sourceDomain,
      actorHandle: verified.actorHandle,
      did: verified.userAction.did,
    });

    const actorUrl = `swarm://${actorDomain}/${verified.actorHandle}`;
    const outcome = await db.transaction(async (tx) => {
      const [claim] = await tx.insert(swarmInboundActions).values({
        sourceDomain: actorDomain,
        action: 'unfollow',
        interactionId: verified.replayId,
      }).onConflictDoNothing().returning({ id: swarmInboundActions.id });
      if (!claim) return 'replay' as const;

      const ordered = await applyOrderedFederatedRelationshipState(tx, {
        sourceDomain: actorDomain,
        relationshipKind: 'follow',
        target: targetUser.id,
        state: false,
        userAction: verified.userAction,
      }, async () => {
        const [deleted] = await tx.delete(remoteFollowers).where(and(
          eq(remoteFollowers.userId, targetUser.id),
          eq(remoteFollowers.actorUrl, actorUrl),
        )).returning({ id: remoteFollowers.id });
        if (deleted) {
          await tx.update(users)
            .set({ followersCount: sql`max(0, ${users.followersCount} - 1)` })
            .where(eq(users.id, targetUser.id));
        }
        return deleted ? 'deleted' as const : 'unchanged' as const;
      });
      if (!ordered.applied) {
        return ordered.reason === 'duplicate' ? 'replay' as const : 'stale' as const;
      }
      return ordered.value;
    });

    return NextResponse.json({
      success: true,
      message: outcome === 'replay' ? 'Interaction already processed' : 'Unfollow received',
    });
  } catch (error) {
    if (error instanceof FederationRequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof FederatedIdentityContinuityError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request', details: error.issues }, { status: 400 });
    }
    console.error('[Swarm] Unfollow error:', error);
    return NextResponse.json({ error: 'Failed to process unfollow' }, { status: 500 });
  }
}
