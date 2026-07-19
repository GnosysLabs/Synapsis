/**
 * Swarm Replies Endpoint
 * 
 * POST: Receive a reply from another node
 * GET: Fetch replies to a post on this node
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, posts, users, media, notifications, swarmInboundActions } from '@/db';
import { eq, desc, and, sql } from 'drizzle-orm';
import { z } from 'zod';
import { signingPublicKeyFromDid } from '@/lib/crypto/did-key';
import { signedUserActionSchema } from '@/lib/e2ee/protocol';
import { isPostSensitive, redactSensitivePostForViewer } from '@/lib/nsfw/content-visibility';
import { isTrustedFederationRead } from '@/lib/swarm/signed-read';
import { upsertRemoteUser } from '@/lib/swarm/user-cache';
import {
  FederatedIdentityContinuityError,
  federatedActionFailureInit,
  federationActionContextSchema,
  federationActionDomain,
  pinVerifiedFederatedActorIdentity,
  verifyFederatedUserAction,
} from '@/lib/swarm/federated-action';
import { hasStrictLocalUserOrigin } from '@/lib/swarm/local-user-origin';
import { parseSwarmPostId } from '@/lib/swarm/post-id';
import { shouldSuppressRemoteInteraction } from '@/lib/swarm/remote-interaction-policy';
import {
  createRelayedReplyProvenance,
  federatedReplyEnvelopeSchema,
  federatedReplyUserActionDataSchema,
  relayedReplyProvenanceSchema,
} from '@/lib/swarm/reply-provenance';
import { FederationRequestBodyError, readLimitedJson } from '@/lib/swarm/request-body';

// The same exact schema is persisted with the source node signature so other
// peers can independently verify a relayed reply instead of trusting us.
const swarmReplySchema = federatedReplyEnvelopeSchema;

const swarmReplyDeletionSchema = z.object({
  federation: federationActionContextSchema,
  userAction: signedUserActionSchema,
  replyId: z.string().uuid(),
  nodeDomain: z.string().min(1).max(253),
  authorHandle: z.string().min(1).max(64),
  timestamp: z.string().datetime(),
}).strict();

const replyActionDataSchema = federatedReplyUserActionDataSchema;

const deleteReplyActionDataSchema = z.strictObject({
  postId: z.string().min(1).max(512),
});

const swarmReplyPostIdSchema = z.string().uuid();
const MAX_REPLY_REQUEST_BYTES = 64 * 1024;
const MAX_STORED_REPLY_PROVENANCE_BYTES = 32 * 1024;

class FederatedReplyConflictError extends Error {
  constructor() {
    super('Reply ID conflicts with an existing reply');
    this.name = 'FederatedReplyConflictError';
  }
}

async function syncParentReplyCount(postId: string) {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(posts)
    .where(and(
      eq(posts.replyToId, postId),
      eq(posts.isRemoved, false)
    ));

  await db.update(posts)
    .set({ repliesCount: Number(count || 0) })
    .where(eq(posts.id, postId));
}

function parseStoredReplyProvenance(value: string | null) {
  if (!value) return null;
  try {
    const parsed = relayedReplyProvenanceSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/swarm/replies
 * 
 * Receives a signed reply from another swarm node and stores it locally
 * against the target post so reply counts, thread views, and notifications work.
 */
export async function POST(request: NextRequest) {
  try {
    const validation = swarmReplySchema.safeParse(await readLimitedJson(
      request,
      MAX_REPLY_REQUEST_BYTES,
    ));
    if (!validation.success) {
      return NextResponse.json({ error: 'Invalid request', details: validation.error.issues }, { status: 400 });
    }
    const signature = request.headers.get('X-Swarm-Signature');
    const sourceDomainHeader = request.headers.get('X-Swarm-Source-Domain');
    if (!signature || !sourceDomainHeader) {
      return NextResponse.json({ error: 'Missing swarm signature headers' }, { status: 401 });
    }
    const data = validation.data;
    const sourceDomain = federationActionDomain(sourceDomainHeader);
    if (!sourceDomain || federationActionDomain(data.reply.nodeDomain) !== sourceDomain) {
      return NextResponse.json({ error: 'Source domain mismatch' }, { status: 403 });
    }
    const verified = await verifyFederatedUserAction({
      payload: data,
      nodeSignature: signature,
      sourceDomain,
      expectedMethod: 'POST',
      expectedPath: '/api/swarm/replies',
      expectedAction: 'post',
      actorHandle: data.reply.author.handle,
      replayBinding: { postId: data.postId, replyId: data.reply.id },
      maxActionsPerMinute: 30,
    });
    if (!verified.ok) {
      return NextResponse.json({ error: verified.error }, federatedActionFailureInit(verified));
    }

    const actionData = replyActionDataSchema.safeParse(verified.userAction.data);
    const signedMediaUrls = actionData.success
      ? (actionData.data.mediaManifest || []).map((item) => item.url)
      : [];
    if (!actionData.success
      || actionData.data.clientPostId !== data.reply.id
      || actionData.data.content.trim() !== data.reply.content
      || federationActionDomain(actionData.data.swarmReplyTo.nodeDomain)
        !== verified.destinationDomain
      || actionData.data.swarmReplyTo.postId !== data.postId
      || signedMediaUrls.length !== (data.reply.mediaUrls || []).length
      || signedMediaUrls.some((url, index) => url !== data.reply.mediaUrls?.[index])
      || data.reply.author.did !== verified.userAction.did) {
      return NextResponse.json({ error: 'Reply is not user-authorized' }, { status: 403 });
    }

    const federationReplyProvenanceJson = JSON.stringify(
      createRelayedReplyProvenance(data, signature),
    );
    if (Buffer.byteLength(federationReplyProvenanceJson, 'utf8')
      > MAX_STORED_REPLY_PROVENANCE_BYTES) {
      return NextResponse.json({ error: 'Reply authorization proof is too large' }, { status: 413 });
    }

    const parentPost = await db.query.posts.findFirst({
      where: { AND: [{ id: data.postId }, { isRemoved: false }] },
      with: {
        author: true,
      },
    });

    if (!parentPost || !hasStrictLocalUserOrigin(parentPost.author)) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }
    const replyApId = `swarm:${sourceDomain}:${data.reply.id}`;
    const conflictingReply = await db.query.posts.findFirst({
      where: { apId: replyApId },
      with: { author: true },
    });
    if (conflictingReply && (
      conflictingReply.author.did !== verified.userAction.did
      || conflictingReply.content !== data.reply.content
    )) {
      return NextResponse.json({ error: 'Reply ID conflicts with an existing reply' }, { status: 409 });
    }
    if (await shouldSuppressRemoteInteraction(parentPost.userId, {
      did: verified.userAction.did,
      handle: verified.actorHandle,
      domain: sourceDomain,
    })) {
      return NextResponse.json({ success: true, message: 'Reply received' });
    }

    const remoteHandle = `${verified.actorHandle}@${sourceDomain}`;
    const signingPublicKey = signingPublicKeyFromDid(verified.userAction.did);
    if (!signingPublicKey) {
      return NextResponse.json({ error: 'Reply author DID is not self-certifying' }, { status: 403 });
    }

    const createdAt = new Date(verified.userAction.ts);
    const outcome = await db.transaction(async (tx) => {
      const [claim] = await tx.insert(swarmInboundActions).values({
        sourceDomain,
        action: 'reply',
        interactionId: verified.replayId,
      }).onConflictDoNothing().returning({ id: swarmInboundActions.id });

      const existingReply = await tx.query.posts.findFirst({
        where: { apId: replyApId },
        with: { author: true },
      });
      if (existingReply) {
        if (existingReply.author.did !== verified.userAction.did
          || existingReply.content !== data.reply.content) {
          throw new FederatedReplyConflictError();
        }
        await tx.update(posts).set({ federationReplyProvenanceJson })
          .where(eq(posts.id, existingReply.id));
        return claim ? 'unchanged' as const : 'replay' as const;
      }
      if (!claim) return 'replay' as const;

      await pinVerifiedFederatedActorIdentity({
        sourceDomain,
        actorHandle: verified.actorHandle,
        did: verified.userAction.did,
      }, tx);
      await upsertRemoteUser({
        handle: remoteHandle,
        displayName: verified.actorHandle,
        avatarUrl: null,
        did: verified.userAction.did,
        publicKey: signingPublicKey,
        isNsfw: actionData.data.isNsfw ?? true,
      }, { identityVerified: true }, tx);
      const remoteUser = await tx.query.users.findFirst({
        where: { did: verified.userAction.did },
      });
      if (!remoteUser) {
        throw new Error('Failed to resolve remote author');
      }

      const [createdReply] = await tx.insert(posts).values({
        userId: remoteUser.id,
        content: data.reply.content,
        replyToId: data.postId,
        apId: replyApId,
        apUrl: `https://${sourceDomain}/posts/${data.reply.id}`,
        createdAt,
        updatedAt: createdAt,
        federationReplyProvenanceJson,
        isNsfw: actionData.data.isNsfw !== false
          || data.reply.isNsfw === true
          || data.reply.author.isNsfw === true
          || data.reply.nodeIsNsfw === true,
      }).returning();

      if (signedMediaUrls.length) {
        await tx.insert(media).values(signedMediaUrls.map((url, index) => ({
          userId: remoteUser.id,
          postId: createdReply.id,
          url,
          altText: `Remote reply attachment ${index + 1}`,
        })));
      }

      if (parentPost.userId !== remoteUser.id) {
        await tx.insert(notifications).values({
          userId: parentPost.userId,
          actorHandle: verified.actorHandle,
          actorDisplayName: verified.actorHandle,
          actorAvatarUrl: null,
          actorNodeDomain: sourceDomain,
          postId: data.postId,
          postContent: data.reply.content.slice(0, 200),
          interactionId: `reply:remote:${sourceDomain}:${verified.replayId}`,
          type: 'reply',
        }).onConflictDoNothing();
      }
      return 'created' as const;
    });

    await syncParentReplyCount(data.postId);
    return NextResponse.json({
      success: true,
      message: outcome === 'replay' ? 'Reply already received' : 'Reply received',
    });
  } catch (error) {
    if (error instanceof FederatedReplyConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof FederatedIdentityContinuityError) {
      return NextResponse.json({ error: 'Federated identity changed' }, { status: 409 });
    }
    if (error instanceof FederationRequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Swarm] Receive reply error:', error);
    return NextResponse.json({ error: 'Failed to receive reply' }, { status: 500 });
  }
}

/**
 * DELETE /api/swarm/replies
 * 
 * Receives a deletion request from another node.
 * Removes a reply that was previously delivered.
 */
export async function DELETE(request: NextRequest) {
  try {
    const validation = swarmReplyDeletionSchema.safeParse(await readLimitedJson(
      request,
      MAX_REPLY_REQUEST_BYTES,
    ));
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: validation.error.issues },
        { status: 400 },
      );
    }
    const signature = request.headers.get('X-Swarm-Signature');
    const sourceDomainHeader = request.headers.get('X-Swarm-Source-Domain');
    if (!signature || !sourceDomainHeader) {
      return NextResponse.json({ error: 'Missing swarm signature headers' }, { status: 401 });
    }

    const sourceDomain = federationActionDomain(sourceDomainHeader);
    if (!sourceDomain) {
      return NextResponse.json({ error: 'Invalid source node' }, { status: 400 });
    }
    const { replyId, nodeDomain } = validation.data;
    if (federationActionDomain(nodeDomain) !== sourceDomain) {
      return NextResponse.json({ error: 'Source domain mismatch' }, { status: 403 });
    }
    const verified = await verifyFederatedUserAction({
      payload: validation.data,
      nodeSignature: signature,
      sourceDomain,
      expectedMethod: 'DELETE',
      expectedPath: '/api/swarm/replies',
      expectedAction: 'delete',
      actorHandle: validation.data.authorHandle,
      replayBinding: { replyId },
      maxActionsPerMinute: 30,
    });
    if (!verified.ok) {
      return NextResponse.json({ error: verified.error }, federatedActionFailureInit(verified));
    }
    const actionData = deleteReplyActionDataSchema.safeParse(verified.userAction.data);
    if (!actionData.success
      || ![
        replyId,
        `swarm:${sourceDomain}:${replyId}`,
      ].includes(actionData.data.postId)) {
      return NextResponse.json({ error: 'Reply deletion is not user-authorized' }, { status: 403 });
    }

    // Find the reply by its swarm ID
    const swarmReplyId = `swarm:${sourceDomain}:${replyId}`;
    const existingReply = await db.query.posts.findFirst({
      where: { apId: swarmReplyId },
      with: { author: true },
    });

    if (!existingReply) {
      // Already deleted or never existed
      return NextResponse.json({ success: true, message: 'Reply not found or already deleted' });
    }
    if (existingReply.author.did !== verified.userAction.did
      || existingReply.author.handle !== `${verified.actorHandle}@${sourceDomain}`) {
      return NextResponse.json({ error: 'Reply author mismatch' }, { status: 403 });
    }

    await pinVerifiedFederatedActorIdentity({
      sourceDomain,
      actorHandle: verified.actorHandle,
      did: verified.userAction.did,
    });

    const parentReplyToId = existingReply.replyToId;
    const outcome = await db.transaction(async (tx) => {
      const [claim] = await tx.insert(swarmInboundActions).values({
        sourceDomain,
        action: 'delete_reply',
        interactionId: verified.replayId,
      }).onConflictDoNothing().returning({ id: swarmInboundActions.id });
      if (!claim) return 'replay' as const;
      await tx.delete(posts).where(eq(posts.id, existingReply.id));
      return 'deleted' as const;
    });

    if (parentReplyToId) {
      await syncParentReplyCount(parentReplyToId);
    }

    console.log(`[Swarm] Deleted reply ${swarmReplyId} from ${nodeDomain}`);

    return NextResponse.json({ success: true, replayed: outcome === 'replay' });
  } catch (error) {
    if (error instanceof FederatedIdentityContinuityError) {
      return NextResponse.json({ error: 'Federated identity changed' }, { status: 409 });
    }
    if (error instanceof FederationRequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Swarm] Delete reply error:', error);
    return NextResponse.json({ error: 'Failed to delete reply' }, { status: 500 });
  }
}

/**
 * GET /api/swarm/replies?postId=xxx
 * 
 * Returns replies to a specific post on this node.
 * Used by other nodes to fetch reply threads.
 */
export async function GET(request: NextRequest) {
  try {
    if (!db) {
      return NextResponse.json({ replies: [] });
    }

    const { searchParams } = new URL(request.url);
    const postIdValidation = swarmReplyPostIdSchema.safeParse(searchParams.get('postId'));
    if (!postIdValidation.success) {
      return NextResponse.json({ error: 'Valid postId required' }, { status: 400 });
    }
    const postId = postIdValidation.data;

    const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost';
    const localNodeIsNsfw = await (await import('@/lib/node/local-node'))
      .requireLocalNodeNsfwClassification();
    const trustedRead = await isTrustedFederationRead(request);
    const parentPost = await db.query.posts.findFirst({
      where: { AND: [{ id: postId }, { isRemoved: false }] },
      with: { author: true },
    });
    if (!parentPost) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }
    const parentIsRemote = parentPost.author.handle.includes('@')
      || (parentPost.author.nodeId !== null && parentPost.author.nodeId !== undefined);
    const parentIsSensitive = isPostSensitive({
      postIsNsfw: parentPost.isNsfw,
      authorIsNsfw: parentPost.author.isNsfw,
      nodeIsNsfw: parentIsRemote ? undefined : localNodeIsNsfw,
      isRemote: parentIsRemote,
    });
    if (parentIsSensitive && !trustedRead) {
      return NextResponse.json(
        { error: 'Sensitive thread requires a trusted federation read' },
        { status: 403, headers: { 'Cache-Control': 'private, no-store' } },
      );
    }

    // Get replies to this post
    const replies = await db
      .select({
        id: posts.id,
        apId: posts.apId,
        content: posts.content,
        createdAt: posts.createdAt,
        likesCount: posts.likesCount,
        repostsCount: posts.repostsCount,
        repliesCount: posts.repliesCount,
        federationReplyProvenanceJson: posts.federationReplyProvenanceJson,
        authorHandle: users.handle,
        authorDisplayName: users.displayName,
        authorAvatarUrl: users.avatarUrl,
        authorIsNsfw: users.isNsfw,
        authorNodeId: users.nodeId,
        postIsNsfw: posts.isNsfw,
      })
      .from(posts)
      .innerJoin(users, eq(posts.userId, users.id))
      .where(
        and(
          eq(posts.replyToId, postId),
          eq(posts.isRemoved, false)
        )
      )
      .orderBy(desc(posts.createdAt))
      .limit(50);

    // Format replies for swarm consumption
    const formattedReplies = replies.map((reply) => {
      const authorIsRemote = reply.authorHandle.includes('@')
        || (reply.authorNodeId !== null && reply.authorNodeId !== undefined);
      const handleParts = reply.authorHandle.split('@');
      const parsedRemotePostId = reply.apId?.startsWith('swarm:')
        ? parseSwarmPostId(reply.apId)
        : null;
      const remoteDomain = parsedRemotePostId?.domain
        || (authorIsRemote && handleParts.length > 1
          ? handleParts[handleParts.length - 1]
          : null);
      const provenance = parseStoredReplyProvenance(reply.federationReplyProvenanceJson);
      const provenanceActionData = provenance
        ? federatedReplyUserActionDataSchema.safeParse(provenance.payload.userAction.data)
        : null;
      const provenanceMedia = provenanceActionData?.success
        ? (provenanceActionData.data.mediaManifest || []).map((item) => ({
            url: item.url,
            altText: item.altText,
            mimeType: item.mimeType,
          }))
        : [];
      const hasPortableProvenance = Boolean(
        provenance
        && provenanceActionData?.success
        && remoteDomain
        && federationActionDomain(provenance.payload.federation.sourceDomain) === remoteDomain
        && federationActionDomain(provenance.payload.federation.destinationDomain)
          === federationActionDomain(nodeDomain)
        && provenance.payload.postId === postId
        && provenance.payload.reply.id === parsedRemotePostId?.originalPostId
        && provenance.payload.reply.content === reply.content
        && provenanceActionData.data.clientPostId === parsedRemotePostId?.originalPostId
        && provenanceActionData.data.content.trim() === reply.content
        && provenanceActionData.data.swarmReplyTo.postId === postId
        && federationActionDomain(provenanceActionData.data.swarmReplyTo.nodeDomain)
          === federationActionDomain(nodeDomain)
      );

      return {
        id: parsedRemotePostId?.originalPostId || reply.id,
        content: reply.content,
        createdAt: hasPortableProvenance
          ? new Date(provenance!.payload.userAction.ts).toISOString()
          : reply.createdAt.toISOString(),
        author: {
          handle: remoteDomain ? handleParts.slice(0, -1).join('@') : reply.authorHandle,
          displayName: reply.authorDisplayName || reply.authorHandle,
          avatarUrl: reply.authorAvatarUrl || undefined,
          isNsfw: reply.authorIsNsfw,
          isRemote: authorIsRemote,
          nodeId: reply.authorNodeId,
          nodeIsNsfw: authorIsRemote ? undefined : localNodeIsNsfw,
        },
        nodeDomain: remoteDomain || (authorIsRemote ? null : nodeDomain),
        media: hasPortableProvenance ? provenanceMedia : [],
        likeCount: reply.likesCount,
        repostCount: reply.repostsCount,
        replyCount: reply.repliesCount,
        isNsfw: reply.postIsNsfw,
        nodeIsNsfw: authorIsRemote ? undefined : localNodeIsNsfw,
        isRemote: authorIsRemote,
        provenance: hasPortableProvenance ? provenance : undefined,
      };
    });
    const responseReplies = trustedRead
      ? formattedReplies
      : formattedReplies
          .map((reply) => {
            const replyWithoutProvenance = { ...reply } as Record<string, unknown>;
            delete replyWithoutProvenance.provenance;
            return redactSensitivePostForViewer(
              replyWithoutProvenance,
              {
                canViewSensitive: false,
                localNodeDomain: nodeDomain,
                localNodeIsNsfw,
              },
            );
          })
          .filter((reply) => reply.sensitiveContentRestricted !== true);

    return NextResponse.json({
      postId,
      replies: responseReplies,
      nodeDomain,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('[Swarm] Fetch replies error:', error);
    return NextResponse.json({ error: 'Failed to fetch replies' }, { status: 500 });
  }
}
