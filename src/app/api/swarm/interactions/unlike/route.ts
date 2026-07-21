import { NextRequest, NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db, posts, remoteLikes, swarmInboundActions } from '@/db';
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
import { federatedHandleSchema, nodeDomainSchema } from '@/lib/utils/federation';

const PATH = '/api/swarm/interactions/unlike' as const;

const swarmUnlikeSchema = z.strictObject({
  federation: federationActionContextSchema,
  userAction: signedUserActionSchema,
  postId: z.string().uuid(),
  unlike: z.strictObject({
    actorHandle: federatedHandleSchema,
    actorNodeDomain: nodeDomainSchema,
    interactionId: z.string().uuid(),
    timestamp: z.string().datetime(),
  }),
  signature: z.string().min(1).max(16_384),
});

const unlikeActionDataSchema = z.strictObject({ postId: z.string().min(1).max(512) });

export async function POST(request: NextRequest) {
  try {
    const data = swarmUnlikeSchema.parse(await readLimitedJson(request));
    if (!isFreshFederationTimestamp(data.unlike.timestamp)) {
      return NextResponse.json({ error: 'Stale interaction' }, { status: 400 });
    }

    const actorDomain = federationActionDomain(data.unlike.actorNodeDomain);
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
      expectedAction: 'unlike',
      actorHandle: data.unlike.actorHandle,
      replayBinding: { postId: data.postId },
      maxActionsPerMinute: 60,
    });
    if (!verified.ok) {
      return NextResponse.json({ error: verified.error }, federatedActionFailureInit(verified));
    }

    const actionData = unlikeActionDataSchema.safeParse(verified.userAction.data);
    if (!actionData.success
      || actionData.data.postId !== `swarm:${verified.destinationDomain}:${data.postId}`) {
      return NextResponse.json({ error: 'Unlike target is not user-authorized' }, { status: 403 });
    }
    const post = await db.query.posts.findFirst({
      where: { AND: [{ id: data.postId }, { isRemoved: false }] },
      with: { author: true },
    });
    if (!post || !hasStrictLocalUserOrigin(post.author)) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }
    await pinVerifiedFederatedActorIdentity({
      sourceDomain: verified.sourceDomain,
      actorHandle: verified.actorHandle,
      did: verified.userAction.did,
    });

    const outcome = await db.transaction(async (tx) => {
      const [claim] = await tx.insert(swarmInboundActions).values({
        sourceDomain: actorDomain,
        action: 'unlike',
        interactionId: verified.replayId,
      }).onConflictDoNothing().returning({ id: swarmInboundActions.id });
      if (!claim) return 'replay' as const;

      const ordered = await applyOrderedFederatedRelationshipState(tx, {
        sourceDomain: actorDomain,
        relationshipKind: 'like',
        target: data.postId,
        state: false,
        userAction: verified.userAction,
      }, async () => {
        const [deleted] = await tx.delete(remoteLikes).where(and(
          eq(remoteLikes.postId, data.postId),
          eq(remoteLikes.actorHandle, verified.actorHandle),
          eq(remoteLikes.actorNodeDomain, actorDomain),
        )).returning({ id: remoteLikes.id });

        if (deleted) {
          await tx.update(posts)
            .set({ likesCount: sql`max(0, ${posts.likesCount} - 1)` })
            .where(and(eq(posts.id, data.postId), eq(posts.isRemoved, false)));
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
      message: outcome === 'replay' ? 'Interaction already processed' : 'Unlike received',
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
    console.error('[Swarm] Unlike error:', error);
    return NextResponse.json({ error: 'Failed to process unlike' }, { status: 500 });
  }
}
