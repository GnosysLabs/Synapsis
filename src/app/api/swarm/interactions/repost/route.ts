import { NextRequest, NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  db,
  notifications,
  posts,
  remoteReposts,
  swarmInboundActions,
} from '@/db';
import { signedUserActionSchema } from '@/lib/e2ee/protocol';
import {
  FederatedIdentityContinuityError,
  federationActionContextSchema,
  federationActionDomain,
  pinVerifiedFederatedActorIdentity,
  verifyFederatedUserAction,
} from '@/lib/swarm/federated-action';
import { hasStrictLocalUserOrigin } from '@/lib/swarm/local-user-origin';
import { applyOrderedFederatedRelationshipState } from '@/lib/swarm/relationship-ordering';
import { FederationRequestBodyError, readLimitedJson } from '@/lib/swarm/request-body';
import { isFreshFederationTimestamp } from '@/lib/swarm/signature';
import {
  federationMediaUrlSchema,
  localHandleSchema,
  nodeDomainSchema,
} from '@/lib/utils/federation';

const PATH = '/api/swarm/interactions/repost' as const;

const swarmRepostSchema = z.strictObject({
  federation: federationActionContextSchema,
  userAction: signedUserActionSchema,
  postId: z.string().uuid(),
  repost: z.strictObject({
    actorHandle: localHandleSchema,
    actorDisplayName: z.string().min(1).max(50),
    actorAvatarUrl: federationMediaUrlSchema.optional(),
    actorIsNsfw: z.boolean(),
    actorNodeDomain: nodeDomainSchema,
    repostId: z.string().uuid(),
    interactionId: z.string().uuid(),
    timestamp: z.string().datetime(),
  }),
  signature: z.string().min(1).max(16_384),
});

const repostActionDataSchema = z.strictObject({ postId: z.string().min(1).max(512) });

export async function POST(request: NextRequest) {
  try {
    const data = swarmRepostSchema.parse(await readLimitedJson(request));
    if (!isFreshFederationTimestamp(data.repost.timestamp)) {
      return NextResponse.json({ error: 'Stale interaction' }, { status: 400 });
    }

    const actorDomain = federationActionDomain(data.repost.actorNodeDomain);
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
      expectedAction: 'repost',
      actorHandle: data.repost.actorHandle,
      replayBinding: { postId: data.postId },
      maxActionsPerMinute: 30,
    });
    if (!verified.ok) {
      return NextResponse.json({ error: verified.error }, { status: verified.status });
    }

    const actionData = repostActionDataSchema.safeParse(verified.userAction.data);
    if (!actionData.success
      || actionData.data.postId !== `swarm:${verified.destinationDomain}:${data.postId}`) {
      return NextResponse.json({ error: 'Repost target is not user-authorized' }, { status: 403 });
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
    const nodeMute = await db.query.mutedNodes.findFirst({
      where: { AND: [{ userId: post.userId }, { nodeDomain: actorDomain }] },
      columns: { id: true },
    });
    if (nodeMute) {
      return NextResponse.json({ success: true, message: 'Repost received' });
    }

    const outcome = await db.transaction(async (tx) => {
      const [claim] = await tx.insert(swarmInboundActions).values({
        sourceDomain: actorDomain,
        action: 'repost',
        interactionId: verified.replayId,
      }).onConflictDoNothing().returning({ id: swarmInboundActions.id });
      if (!claim) return 'replay' as const;

      const ordered = await applyOrderedFederatedRelationshipState(tx, {
        sourceDomain: actorDomain,
        relationshipKind: 'repost',
        target: data.postId,
        state: true,
        userAction: verified.userAction,
      }, async () => {
        const [inserted] = await tx.insert(remoteReposts).values({
          postId: data.postId,
          actorHandle: verified.actorHandle,
          actorDisplayName: verified.actorHandle,
          actorAvatarUrl: null,
          // A hostile node cannot authoritatively downgrade an account to safe.
          actorIsNsfw: true,
          actorNodeDomain: actorDomain,
        }).onConflictDoNothing().returning({ id: remoteReposts.id });
        if (!inserted) return 'unchanged' as const;

        const [updatedPost] = await tx.update(posts)
          .set({ repostsCount: sql`${posts.repostsCount} + 1` })
          .where(and(eq(posts.id, data.postId), eq(posts.isRemoved, false)))
          .returning({ id: posts.id });
        if (!updatedPost) throw new Error('Repost target disappeared');

        await tx.insert(notifications).values({
          userId: post.userId,
          actorHandle: verified.actorHandle,
          actorDisplayName: verified.actorHandle,
          actorAvatarUrl: null,
          actorNodeDomain: actorDomain,
          postId: data.postId,
          postContent: post.content?.slice(0, 200) || null,
          interactionId: `repost:remote:${actorDomain}:${verified.replayId}`,
          type: 'repost',
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
      message: outcome === 'replay' ? 'Interaction already processed' : 'Repost received',
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
    console.error('[Swarm] Repost error:', error);
    return NextResponse.json({ error: 'Failed to process repost' }, { status: 500 });
  }
}
