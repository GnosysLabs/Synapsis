import { NextRequest, NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  db,
  notifications,
  posts,
  remoteLikes,
  swarmInboundActions,
} from '@/db';
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
import { shouldSuppressRemoteInteraction } from '@/lib/swarm/remote-interaction-policy';
import { applyOrderedFederatedRelationshipState } from '@/lib/swarm/relationship-ordering';
import { FederationRequestBodyError, readLimitedJson } from '@/lib/swarm/request-body';
import { isFreshFederationTimestamp } from '@/lib/swarm/signature';
import {
  federationMediaUrlSchema,
  federatedHandleSchema,
  nodeDomainSchema,
} from '@/lib/utils/federation';

const PATH = '/api/swarm/interactions/like' as const;

const swarmLikeSchema = z.strictObject({
  federation: federationActionContextSchema,
  userAction: signedUserActionSchema,
  postId: z.string().uuid(),
  like: z.strictObject({
    actorHandle: federatedHandleSchema,
    actorDisplayName: z.string().min(1).max(50),
    actorAvatarUrl: federationMediaUrlSchema.optional(),
    actorNodeDomain: nodeDomainSchema,
    interactionId: z.string().uuid(),
    timestamp: z.string().datetime(),
  }),
  signature: z.string().min(1).max(16_384),
});

const likeActionDataSchema = z.strictObject({ postId: z.string().min(1).max(512) });

export async function POST(request: NextRequest) {
  try {
    const data = swarmLikeSchema.parse(await readLimitedJson(request));
    if (!isFreshFederationTimestamp(data.like.timestamp)) {
      return NextResponse.json({ error: 'Stale interaction' }, { status: 400 });
    }

    const actorDomain = federationActionDomain(data.like.actorNodeDomain);
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
      expectedAction: 'like',
      actorHandle: data.like.actorHandle,
      replayBinding: { postId: data.postId },
      maxActionsPerMinute: 60,
    });
    if (!verified.ok) {
      return NextResponse.json({ error: verified.error }, federatedActionFailureInit(verified));
    }

    const actionData = likeActionDataSchema.safeParse(verified.userAction.data);
    if (!actionData.success
      || actionData.data.postId !== `swarm:${verified.destinationDomain}:${data.postId}`) {
      return NextResponse.json({ error: 'Like target is not user-authorized' }, { status: 403 });
    }
    // Validate a strict local target before persisting any attacker-controlled
    // identity or replay state. Otherwise a valid hostile node could grow the
    // permanent handle registry by targeting random post IDs.
    const post = await db.query.posts.findFirst({
      where: { AND: [{ id: data.postId }, { isRemoved: false }] },
      with: { author: true },
    });
    if (!post || !hasStrictLocalUserOrigin(post.author)) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }
    if (await shouldSuppressRemoteInteraction(post.userId, {
      did: verified.userAction.did,
      handle: verified.actorHandle,
      domain: actorDomain,
    })) {
      return NextResponse.json({ success: true, message: 'Like received' });
    }
    await pinVerifiedFederatedActorIdentity({
      sourceDomain: verified.sourceDomain,
      actorHandle: verified.actorHandle,
      did: verified.userAction.did,
    });

    const outcome = await db.transaction(async (tx) => {
      const [claim] = await tx.insert(swarmInboundActions).values({
        sourceDomain: actorDomain,
        action: 'like',
        interactionId: verified.replayId,
      }).onConflictDoNothing().returning({ id: swarmInboundActions.id });
      if (!claim) return 'replay' as const;

      const ordered = await applyOrderedFederatedRelationshipState(tx, {
        sourceDomain: actorDomain,
        relationshipKind: 'like',
        target: data.postId,
        state: true,
        userAction: verified.userAction,
      }, async () => {
        const [inserted] = await tx.insert(remoteLikes).values({
          postId: data.postId,
          actorHandle: verified.actorHandle,
          actorNodeDomain: actorDomain,
        }).onConflictDoNothing().returning({ id: remoteLikes.id });
        if (!inserted) return 'unchanged' as const;

        const [updatedPost] = await tx.update(posts)
          .set({ likesCount: sql`${posts.likesCount} + 1` })
          .where(and(eq(posts.id, data.postId), eq(posts.isRemoved, false)))
          .returning({ id: posts.id });
        if (!updatedPost) throw new Error('Like target disappeared');

        await tx.insert(notifications).values({
          userId: post.userId,
          actorHandle: verified.actorHandle,
          // Display metadata asserted only by a hostile node is not identity proof.
          actorDisplayName: verified.actorUsername,
          actorAvatarUrl: null,
          actorNodeDomain: actorDomain,
          postId: data.postId,
          postContent: post.content?.slice(0, 200) || null,
          interactionId: `like:remote:${actorDomain}:${verified.replayId}`,
          type: 'like',
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
      message: outcome === 'replay' ? 'Interaction already processed' : 'Like received',
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
    console.error('[Swarm] Like error:', error);
    return NextResponse.json({ error: 'Failed to process like' }, { status: 500 });
  }
}
