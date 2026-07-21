import { z } from 'zod';

import { verifyActionSignature, type SignedAction } from '@/lib/auth/verify-signature';
import { signingPublicKeyFromDid } from '@/lib/crypto/did-key';
import { signedUserActionSchema } from '@/lib/e2ee/protocol';
import {
  federationMediaUrlSchema,
  federatedHandleSchema,
  nodeDomainSchema,
} from '@/lib/utils/federation';
import {
  FEDERATED_ACTION_MAX_AGE_MS,
  FEDERATED_ACTION_PROTOCOL,
  federationActionContextSchema,
  federationActionDomain,
} from './federated-action';
import { verifySwarmRequest } from './signature';
import { resolveAccountAddress } from '@/lib/identity/account-address';
import { verifyStuffboxBadgeAttestation } from '@/lib/stuffbox/badge';
import type { StuffboxBadge } from '@/lib/types';

export const RELAYED_REPLY_PROVENANCE_PROTOCOL = 'synapsis-relayed-reply-v1' as const;
const signedPresentationUrl = z.string().url().max(2_048);
const stuffboxBadgeTransportSchema = z.strictObject({
  level: z.enum(['connected', 'supporter']),
  plan: z.enum(['free', 'mini', 'personal', 'plus', 'power', 'max', 'ultra']),
  issuer: z.string().url().max(2_048),
  attestation: z.string().min(100).max(8 * 1_024),
  expiresAt: z.string().datetime(),
});

const replyMediaManifestItemSchema = z.strictObject({
  id: z.string().uuid(),
  url: federationMediaUrlSchema,
  altText: z.string().max(2_000).nullish(),
  mimeType: z.string().max(255).nullish(),
});

export const federatedReplyUserActionDataSchema = z.strictObject({
  clientPostId: z.string().uuid(),
  content: z.string().max(600),
  replyToId: z.string().uuid().optional(),
  swarmReplyTo: z.strictObject({
    postId: z.string().uuid(),
    nodeDomain: nodeDomainSchema,
    content: z.string().max(600).optional(),
    author: z.strictObject({
      handle: z.string().min(1).max(320),
      displayName: z.string().max(100).optional().nullable(),
      avatarUrl: signedPresentationUrl.optional().nullable(),
      nodeDomain: nodeDomainSchema.optional().nullable(),
    }).optional(),
  }),
  mediaIds: z.array(z.string().uuid()).max(4).optional(),
  mediaManifest: z.array(replyMediaManifestItemSchema).max(4).optional(),
  isNsfw: z.boolean().optional(),
  linkPreview: z.strictObject({
    url: signedPresentationUrl,
    title: z.string().max(300).optional(),
    description: z.string().max(1_000).optional(),
    image: signedPresentationUrl.optional().nullable(),
    type: z.enum(['card', 'image', 'gallery', 'video']).optional().nullable(),
    videoUrl: signedPresentationUrl.optional().nullable(),
    media: z.array(z.strictObject({
      url: signedPresentationUrl,
      width: z.number().nonnegative().max(100_000).optional().nullable(),
      height: z.number().nonnegative().max(100_000).optional().nullable(),
      mimeType: z.string().max(255).optional().nullable(),
    })).max(4).optional().nullable(),
  }).optional().nullable(),
});

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
      handle: federatedHandleSchema,
      displayName: z.string().max(50).optional().nullable(),
      avatarUrl: federationMediaUrlSchema.optional(),
      did: z.string().min(1).max(2_048),
      publicKey: z.string().min(1).max(2_048).optional(),
      isNsfw: z.boolean().optional(),
      stuffboxBadge: stuffboxBadgeTransportSchema.optional().nullable(),
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
  authorDisplayName: string | null;
  authorAvatarUrl: string | null;
  media: Array<{
    url: string;
    altText?: string | null;
    mimeType?: string | null;
  }>;
  isNsfw: boolean;
  nodeIsNsfw: boolean;
  stuffboxBadge: StuffboxBadge | null;
}

export type NodeProofVerifier = (
  payload: unknown,
  signature: string,
  senderDomain: string,
) => Promise<boolean>;

export type BadgeProofVerifier = (
  attestation: string,
  expectedHandle: string,
) => Promise<StuffboxBadge | null>;

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
  verifyBadgeProof?: BadgeProofVerifier;
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
  const actorAddress = resolveAccountAddress(payload.userAction.handle, sourceDomain);
  const envelopeAddress = resolveAccountAddress(payload.reply.author.handle, sourceDomain);
  const presentationAddress = resolveAccountAddress(input.presentation.author.handle, sourceDomain);
  const signingPublicKey = signingPublicKeyFromDid(payload.userAction.did);
  if (!actionData.success
    || payload.userAction.action !== 'post'
    || !actorAddress
    || !envelopeAddress
    || !presentationAddress
    || actorAddress.homeDomain !== sourceDomain
    || envelopeAddress.canonical !== actorAddress.canonical
    || presentationAddress.canonical !== actorAddress.canonical
    || (payload.federation.protocol === FEDERATED_ACTION_PROTOCOL
      && (payload.userAction.handle !== actorAddress.canonical
        || payload.reply.author.handle !== envelopeAddress.canonical))
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
  const candidateBadge = payload.reply.author.stuffboxBadge;
  const verifyBadgeProof = input.verifyBadgeProof ?? verifyStuffboxBadgeAttestation;
  const stuffboxBadge = candidateBadge?.attestation
    ? await verifyBadgeProof(candidateBadge.attestation, actorAddress.canonical)
    : null;

  return {
    id: payload.reply.id,
    content: payload.reply.content,
    createdAt: expectedCreatedAt,
    nodeDomain: sourceDomain,
    authorDid: payload.userAction.did,
    authorHandle: actorAddress.canonical,
    // Presentation comes only from the original home-node-signed envelope.
    // The relay's editable presentation is never trusted for these fields.
    authorDisplayName: payload.reply.author.displayName?.trim() || null,
    authorAvatarUrl: payload.reply.author.avatarUrl || null,
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
    stuffboxBadge,
  };
}
