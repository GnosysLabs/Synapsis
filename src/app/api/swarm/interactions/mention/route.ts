import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  db,
  notifications,
  swarmInboundActions,
} from '@/db';
import { signedUserActionSchema } from '@/lib/e2ee/protocol';
import { parseMentions, uniqueMentions } from '@/lib/mentions/parser';
import {
  FederatedIdentityContinuityError,
  FEDERATED_ACTION_PROTOCOL,
  federatedActionFailureBody,
  federatedActionFailureInit,
  federationActionContextSchema,
  federationActionDomain,
  pinVerifiedFederatedActorIdentity,
  verifyFederatedUserAction,
} from '@/lib/swarm/federated-action';
import { FederationRequestBodyError, readLimitedJson } from '@/lib/swarm/request-body';
import {
  federationMediaUrlSchema,
  federatedHandleSchema,
  nodeDomainSchema,
} from '@/lib/utils/federation';
import { resolveAccountAddress } from '@/lib/identity/account-address';

const PATH = '/api/swarm/interactions/mention' as const;
const MAX_MENTION_DELIVERY_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

const swarmMentionSchema = z.strictObject({
  federation: federationActionContextSchema,
  userAction: signedUserActionSchema,
  mentionedHandle: federatedHandleSchema,
  mention: z.strictObject({
    actorHandle: federatedHandleSchema,
    actorDisplayName: z.string().min(1).max(50),
    actorAvatarUrl: federationMediaUrlSchema.optional(),
    actorNodeDomain: nodeDomainSchema,
    actorDid: z.string().min(1).max(2_048).optional(),
    actorPublicKey: z.string().min(1).max(16_384).optional(),
    postId: z.string().uuid(),
    postContent: z.string().max(600),
    interactionId: z.string().uuid(),
    timestamp: z.string().datetime(),
  }),
  signature: z.string().min(1).max(16_384),
});

const postActionDataSchema = z.object({
  clientPostId: z.string().uuid(),
  content: z.string().max(650),
}).passthrough();

async function acceptsRemoteMention(
  userId: string,
  actorDomain: string,
  cachedActorId: string | null,
): Promise<boolean> {
  const nodeMute = await db.query.mutedNodes.findFirst({
    where: { AND: [{ userId }, { nodeDomain: actorDomain }] },
    columns: { id: true },
  });
  if (nodeMute) return false;
  if (!cachedActorId) return true;

  const [block, mute] = await Promise.all([
    db.query.blocks.findFirst({
      where: {
        OR: [
          { AND: [{ userId }, { blockedUserId: cachedActorId }] },
          { AND: [{ userId: cachedActorId }, { blockedUserId: userId }] },
        ],
      },
      columns: { id: true },
    }),
    db.query.mutes.findFirst({
      where: { AND: [{ userId }, { mutedUserId: cachedActorId }] },
      columns: { id: true },
    }),
  ]);
  return !block && !mute;
}

export async function POST(request: NextRequest) {
  try {
    const data = swarmMentionSchema.parse(await readLimitedJson(request));
    const actorDomain = federationActionDomain(data.mention.actorNodeDomain);
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
      expectedAction: 'post',
      actorHandle: data.mention.actorHandle,
      replayBinding: {
        mentionedHandle: data.mentionedHandle.toLowerCase(),
        postId: data.mention.postId,
      },
      maxUserActionAgeMs: MAX_MENTION_DELIVERY_AGE_MS,
      maxActionsPerMinute: 120,
    });
    if (!verified.ok) {
      return NextResponse.json(federatedActionFailureBody(verified), federatedActionFailureInit(verified));
    }

    const actionData = postActionDataSchema.safeParse(verified.userAction.data);
    const mentionedAddress = resolveAccountAddress(
      data.mentionedHandle,
      verified.destinationDomain,
    );
    if (!actionData.success
      || !mentionedAddress
      || mentionedAddress.homeDomain !== verified.destinationDomain
      || (data.federation.protocol === FEDERATED_ACTION_PROTOCOL
        && data.mentionedHandle !== mentionedAddress.canonical)
      || actionData.data.clientPostId !== data.mention.postId
      || actionData.data.content.trim() !== data.mention.postContent) {
      return NextResponse.json({ error: 'Mention content is not user-authorized' }, { status: 403 });
    }
    const authorizedMention = uniqueMentions(
      parseMentions(actionData.data.content, verified.sourceDomain),
    ).some((mention) => !mention.isLocal
      && mention.canonicalHandle === mentionedAddress.canonical);
    if (!authorizedMention) {
      return NextResponse.json({ error: 'Mention target is not user-authorized' }, { status: 403 });
    }

    const mentionedUser = await db.query.users.findFirst({
      where: {
        AND: [
          { handle: mentionedAddress.canonical },
          { isLocalAccount: true },
        ],
      },
    });
    if (!mentionedUser || mentionedUser.isSuspended
      || !mentionedUser.isLocalAccount) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    const cachedActor = await db.query.users.findFirst({
      where: { handle: verified.actorHandle },
      columns: { id: true },
    });
    if (!(await acceptsRemoteMention(mentionedUser.id, actorDomain, cachedActor?.id || null))) {
      return NextResponse.json({ success: true, message: 'Mention received' });
    }

    const outcome = await db.transaction(async (tx) => {
      await pinVerifiedFederatedActorIdentity({
        sourceDomain: actorDomain,
        actorHandle: verified.actorHandle,
        did: verified.userAction.did,
      }, tx);

      const [claim] = await tx.insert(swarmInboundActions).values({
        sourceDomain: actorDomain,
        action: 'mention',
        interactionId: verified.replayId,
      }).onConflictDoNothing().returning({ id: swarmInboundActions.id });
      if (!claim) return 'replay' as const;

      await tx.insert(notifications).values({
        userId: mentionedUser.id,
        actorHandle: verified.actorHandle,
        actorDisplayName: data.mention.actorDisplayName,
        actorAvatarUrl: data.mention.actorAvatarUrl || null,
        actorNodeDomain: actorDomain,
        remotePostId: data.mention.postId,
        remotePostDomain: actorDomain,
        postContent: data.mention.postContent.slice(0, 200),
        interactionId: `mention:remote:${actorDomain}:${verified.replayId}`,
        type: 'mention',
      }).onConflictDoNothing();
      return 'created' as const;
    });

    return NextResponse.json({
      success: true,
      message: outcome === 'replay' ? 'Interaction already processed' : 'Mention received',
    });
  } catch (error) {
    if (error instanceof FederationRequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof FederatedIdentityContinuityError) {
      return NextResponse.json({ error: 'Federated identity changed' }, { status: 409 });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request', details: error.issues }, { status: 400 });
    }
    console.error('[Swarm] Mention error:', error);
    return NextResponse.json({ error: 'Failed to process mention' }, { status: 500 });
  }
}
