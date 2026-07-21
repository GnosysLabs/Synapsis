import { NextRequest, NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  db,
  notifications,
  remoteFollowers,
  swarmInboundActions,
  users,
} from '@/db';
import { signedUserActionSchema } from '@/lib/e2ee/protocol';
import {
  FederatedIdentityContinuityError,
  FEDERATED_ACTION_PROTOCOL,
  federatedActionFailureInit,
  federationActionContextSchema,
  federationActionDomain,
  pinVerifiedFederatedActorIdentity,
  verifyFederatedUserAction,
} from '@/lib/swarm/federated-action';
import { hasStrictLocalUserOrigin } from '@/lib/swarm/local-user-origin';
import { shouldSuppressRemoteInteraction } from '@/lib/swarm/remote-interaction-policy';
import { applyOrderedFederatedRelationshipState } from '@/lib/swarm/relationship-ordering';
import { FederationRequestBodyError, readLimitedJson } from '@/lib/swarm/request-body';
import { isFreshFederationTimestamp } from '@/lib/swarm/signature';
import {
  federationMediaUrlSchema,
  federatedHandleSchema,
  nodeDomainSchema,
} from '@/lib/utils/federation';
import { resolveAccountAddress } from '@/lib/identity/account-address';

const PATH = '/api/swarm/interactions/follow' as const;

const swarmFollowSchema = z.strictObject({
  federation: federationActionContextSchema,
  userAction: signedUserActionSchema,
  targetHandle: federatedHandleSchema,
  follow: z.strictObject({
    followerHandle: federatedHandleSchema,
    followerDisplayName: z.string().min(1).max(50),
    followerAvatarUrl: federationMediaUrlSchema.optional(),
    followerBio: z.string().max(500).optional(),
    followerNodeDomain: nodeDomainSchema,
    interactionId: z.string().uuid(),
    timestamp: z.string().datetime(),
  }),
  signature: z.string().min(1).max(16_384),
});

const followActionDataSchema = z.strictObject({ targetHandle: z.string().min(3).max(320) });

export async function POST(request: NextRequest) {
  try {
    const data = swarmFollowSchema.parse(await readLimitedJson(request));
    if (!isFreshFederationTimestamp(data.follow.timestamp)) {
      return NextResponse.json({ error: 'Stale interaction' }, { status: 400 });
    }

    const actorDomain = federationActionDomain(data.follow.followerNodeDomain);
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
      expectedAction: 'follow',
      actorHandle: data.follow.followerHandle,
      replayBinding: { targetHandle: data.targetHandle.toLowerCase() },
      maxActionsPerMinute: 30,
    });
    if (!verified.ok) {
      return NextResponse.json({ error: verified.error }, federatedActionFailureInit(verified));
    }

    const targetAddress = resolveAccountAddress(data.targetHandle, verified.destinationDomain);
    const actionData = followActionDataSchema.safeParse(verified.userAction.data);
    const actionTargetAddress = actionData.success
      ? resolveAccountAddress(actionData.data.targetHandle, verified.destinationDomain)
      : null;
    if (!actionData.success
      || !targetAddress
      || !actionTargetAddress
      || targetAddress.homeDomain !== verified.destinationDomain
      || actionTargetAddress.canonical !== targetAddress.canonical
      || (data.federation.protocol === FEDERATED_ACTION_PROTOCOL
        && (data.targetHandle !== targetAddress.canonical
          || actionData.data.targetHandle !== actionTargetAddress.canonical))) {
      return NextResponse.json({ error: 'Follow target is not user-authorized' }, { status: 403 });
    }
    const targetUser = await db.query.users.findFirst({
      where: { AND: [{ handle: targetAddress.canonical }, { isLocalAccount: true }] },
    });
    if (!targetUser || targetUser.isSuspended || !hasStrictLocalUserOrigin(targetUser)) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    if (await shouldSuppressRemoteInteraction(targetUser.id, {
      did: verified.userAction.did,
      handle: verified.actorHandle,
      domain: actorDomain,
    })) {
      return NextResponse.json({ success: true, message: 'Follow received' });
    }
    await pinVerifiedFederatedActorIdentity({
      sourceDomain: verified.sourceDomain,
      actorHandle: verified.actorHandle,
      did: verified.userAction.did,
    });

    const actorUrl = `swarm://${actorDomain}/${verified.actorUsername}`;
    const outcome = await db.transaction(async (tx) => {
      const [claim] = await tx.insert(swarmInboundActions).values({
        sourceDomain: actorDomain,
        action: 'follow',
        interactionId: verified.replayId,
      }).onConflictDoNothing().returning({ id: swarmInboundActions.id });
      if (!claim) return 'replay' as const;

      const ordered = await applyOrderedFederatedRelationshipState(tx, {
        sourceDomain: actorDomain,
        relationshipKind: 'follow',
        target: targetUser.id,
        state: true,
        userAction: verified.userAction,
      }, async () => {
        const [inserted] = await tx.insert(remoteFollowers).values({
          userId: targetUser.id,
          actorUrl,
          inboxUrl: `https://${actorDomain}/api/swarm/interactions/inbox`,
          handle: verified.actorHandle,
          activityId: verified.replayId,
        }).onConflictDoNothing().returning({ id: remoteFollowers.id });
        if (!inserted) return 'unchanged' as const;

        await tx.update(users)
          .set({ followersCount: sql`${users.followersCount} + 1` })
          .where(eq(users.id, targetUser.id));
        await tx.insert(notifications).values({
          userId: targetUser.id,
          actorHandle: verified.actorHandle,
          actorDisplayName: data.follow.followerDisplayName,
          actorAvatarUrl: data.follow.followerAvatarUrl || null,
          actorNodeDomain: actorDomain,
          interactionId: `follow:remote:${actorDomain}:${verified.replayId}`,
          type: 'follow',
        }).onConflictDoNothing();
        return 'created' as const;
      });
      if (!ordered.applied) {
        return ordered.reason === 'duplicate' ? 'replay' as const : 'stale' as const;
      }
      return ordered.value;
    });

    return NextResponse.json({
      success: true,
      message: outcome === 'replay' ? 'Interaction already processed' : 'Follow received',
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
    console.error('[Swarm] Follow error:', error);
    return NextResponse.json({ error: 'Failed to process follow' }, { status: 500 });
  }
}
