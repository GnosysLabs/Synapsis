import { z } from 'zod';

import { verifyActionSignature, type SignedAction } from '@/lib/auth/verify-signature';
import { signingPublicKeyFromDid } from '@/lib/crypto/did-key';
import { signedUserActionSchema } from '@/lib/e2ee/protocol';
import {
  federationMediaUrlSchema,
  localHandleSchema,
  nodeDomainSchema,
} from '@/lib/utils/federation';
import {
  FEDERATED_ACTION_MAX_AGE_MS,
  federationActionContextSchema,
  federationActionDomain,
} from './federated-action';
import { verifySwarmRequest } from './signature';

export const RELAYED_REPLY_PROVENANCE_PROTOCOL = 'synapsis-relayed-reply-v1' as const;

const replyMediaManifestItemSchema = z.object({
  id: z.string().uuid(),
  url: federationMediaUrlSchema,
  altText: z.string().max(2_000).nullish(),
  mimeType: z.string().max(255).nullish(),
}).passthrough();

export const federatedReplyUserActionDataSchema = z.object({
  clientPostId: z.string().uuid(),
  content: z.string().max(600),
  swarmReplyTo: z.object({
    postId: z.string().uuid(),
    nodeDomain: nodeDomainSchema,
  }),
  mediaManifest: z.array(replyMediaManifestItemSchema).max(4).optional(),
  isNsfw: z.boolean().optional(),
}).passthrough();

/**
 * The exact payload originally signed by the reply author's home node.
 *
 * Its destination-bound federation context remains intact. A relay verifier
 * checks this as historical provenance; it must never reuse this verifier to
 * authorize a new mutation addressed to a different node.
 */
export const federatedReplyEnvelopeSchema = z.strictObject({
  federation: federationActionContextSchema,
  userAction: signedUserActionSchema,
  postId: z.string().uuid(),
  reply: z.strictObject({
    id: z.string().uuid(),
    content: z.string().max(600),
    createdAt: z.string().datetime(),
    author: z.strictObject({
      handle: localHandleSchema,
      displayName: z.string().max(50).optional().nullable(),
      avatarUrl: federationMediaUrlSchema.optional(),
      did: z.string().min(1).max(2_048),
      publicKey: z.string().min(1).max(16_384).optional(),
      isNsfw: z.boolean().optional(),
    }),
    nodeDomain: nodeDomainSchema,
    nodeIsNsfw: z.boolean().optional(),
    isNsfw: z.boolean().optional(),
    mediaUrls: z.array(federationMediaUrlSchema).max(4).optional(),
  }),
});

export const relayedReplyProvenanceSchema = z.strictObject({
  protocol: z.literal(RELAYED_REPLY_PROVENANCE_PROTOCOL),
  payload: federatedReplyEnvelopeSchema,
  nodeSignature: z.string().min(1).max(1_024).regex(/^[A-Za-z0-9+/=]+$/),
});

export type FederatedReplyEnvelope = z.infer<typeof federatedReplyEnvelopeSchema>;
export type RelayedReplyProvenance = z.infer<typeof relayedReplyProvenanceSchema>;

export interface RelayedReplyPresentation {
  id: string;
  content: string;
  createdAt: string;
  nodeDomain?: string | null;
  author: {
    handle: string;
  };
  media?: Array<{
    url: string;
    altText?: string | null;
    mimeType?: string | null;
  }>;
  isNsfw?: boolean;
  nodeIsNsfw?: boolean;
}

export interface VerifiedRelayedReply {
  id: string;
  content: string;
  createdAt: string;
  nodeDomain: string;
  authorDid: string;
  authorHandle: string;
  media: Array<{
    url: string;
    altText?: string | null;
    mimeType?: string | null;
  }>;
  isNsfw: boolean;
  nodeIsNsfw: boolean;
}

export type NodeProofVerifier = (
  payload: unknown,
  signature: string,
  senderDomain: string,
) => Promise<boolean>;

export function createRelayedReplyProvenance(
  payload: FederatedReplyEnvelope,
  nodeSignature: string,
): RelayedReplyProvenance {
  return relayedReplyProvenanceSchema.parse({
    protocol: RELAYED_REPLY_PROVENANCE_PROTOCOL,
    payload,
    nodeSignature,
  });
}

function canonicalLocalHandle(value: string): string | null {
  const handle = value.trim().replace(/^@/, '').toLowerCase();
  return localHandleSchema.safeParse(handle).success ? handle : null;
}

function mediaUrls(value: RelayedReplyPresentation['media']): string[] {
  return (value || []).map((item) => item.url);
}

/**
 * Verify a relayed reply without trusting the relay to assert a third-party
 * identity or edit content.
 *
 * The original node proof establishes the source/destination pair and exact
 * envelope. The self-certifying did:key proof independently establishes the
 * author and signed reply fields. Historical proofs deliberately do not use
 * the current wall clock: freshness was enforced when the destination node
 * accepted the mutation, while the signed interval and user/node timestamps
 * must still be internally consistent.
 */
export async function verifyRelayedReplyProvenance(input: {
  provenance: unknown;
  relayDomain: string;
  expectedParentPostId: string;
  presentation: RelayedReplyPresentation;
  verifyNodeProof?: NodeProofVerifier;
}): Promise<VerifiedRelayedReply | null> {
  const proof = relayedReplyProvenanceSchema.safeParse(input.provenance);
  if (!proof.success) return null;

  const { payload, nodeSignature } = proof.data;
  const relayDomain = federationActionDomain(input.relayDomain);
  const sourceDomain = federationActionDomain(payload.federation.sourceDomain);
  const destinationDomain = federationActionDomain(payload.federation.destinationDomain);
  const replySourceDomain = federationActionDomain(payload.reply.nodeDomain);
  const presentationDomain = federationActionDomain(input.presentation.nodeDomain);
  if (!relayDomain
    || !sourceDomain
    || destinationDomain !== relayDomain
    || replySourceDomain !== sourceDomain
    || presentationDomain !== sourceDomain
    || payload.federation.method !== 'POST'
    || payload.federation.path !== '/api/swarm/replies'
    || payload.postId !== input.expectedParentPostId
    || payload.federation.expiresAt < payload.federation.issuedAt
    || payload.federation.expiresAt - payload.federation.issuedAt > FEDERATED_ACTION_MAX_AGE_MS
    || Math.abs(payload.userAction.ts - payload.federation.issuedAt) > FEDERATED_ACTION_MAX_AGE_MS) {
    return null;
  }

  const actionData = federatedReplyUserActionDataSchema.safeParse(payload.userAction.data);
  const actorHandle = canonicalLocalHandle(payload.userAction.handle);
  const envelopeHandle = canonicalLocalHandle(payload.reply.author.handle);
  const presentationHandle = canonicalLocalHandle(input.presentation.author.handle);
  const signingPublicKey = signingPublicKeyFromDid(payload.userAction.did);
  if (!actionData.success
    || payload.userAction.action !== 'post'
    || !actorHandle
    || envelopeHandle !== actorHandle
    || presentationHandle !== actorHandle
    || payload.reply.author.did !== payload.userAction.did
    || !signingPublicKey
    || !await verifyActionSignature(
      payload.userAction as SignedAction<unknown>,
      signingPublicKey,
    )) {
    return null;
  }

  const signedMedia = actionData.data.mediaManifest || [];
  const signedMediaUrls = signedMedia.map((item) => item.url);
  const envelopeMediaUrls = payload.reply.mediaUrls || [];
  const presentationMediaUrls = mediaUrls(input.presentation.media);
  const expectedCreatedAt = new Date(payload.userAction.ts).toISOString();
  if (actionData.data.clientPostId !== payload.reply.id
    || payload.reply.id !== input.presentation.id
    || actionData.data.content.trim() !== payload.reply.content
    || payload.reply.content !== input.presentation.content
    || federationActionDomain(actionData.data.swarmReplyTo.nodeDomain) !== relayDomain
    || actionData.data.swarmReplyTo.postId !== input.expectedParentPostId
    || signedMediaUrls.length !== envelopeMediaUrls.length
    || signedMediaUrls.some((url, index) => url !== envelopeMediaUrls[index])
    || signedMediaUrls.length !== presentationMediaUrls.length
    || signedMediaUrls.some((url, index) => url !== presentationMediaUrls[index])
    || input.presentation.createdAt !== expectedCreatedAt) {
    return null;
  }

  // DNS/key discovery is the only potentially remote operation. Perform it
  // after every cheap schema, self-certifying user-signature, and exact
  // presentation binding check so a relay cannot amplify arbitrary junk into
  // outbound node-key requests.
  const verifyNodeProof = input.verifyNodeProof ?? verifySwarmRequest;
  if (!await verifyNodeProof(payload, nodeSignature, sourceDomain)) return null;

  return {
    id: payload.reply.id,
    content: payload.reply.content,
    createdAt: expectedCreatedAt,
    nodeDomain: sourceDomain,
    authorDid: payload.userAction.did,
    authorHandle: actorHandle,
    media: signedMedia.map((item) => ({
      url: item.url,
      altText: item.altText,
      mimeType: item.mimeType,
    })),
    // A relay may make a reply more sensitive, but never less sensitive than
    // either signed/source assertion. Unknown remote classifications fail shut.
    isNsfw: input.presentation.isNsfw === true
      || actionData.data.isNsfw !== false
      || payload.reply.isNsfw === true
      || payload.reply.author.isNsfw === true
      || payload.reply.nodeIsNsfw === true,
    nodeIsNsfw: input.presentation.nodeIsNsfw === true
      || payload.reply.nodeIsNsfw !== false,
  };
}
