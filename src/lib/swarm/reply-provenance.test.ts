import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { generateDID } from '@/lib/crypto/did-key';
import { canonicalize } from '@/lib/crypto/user-signing';
import {
  createRelayedReplyProvenance,
  verifyRelayedReplyProvenance,
} from './reply-provenance';

const parentPostId = '11111111-1111-4111-8111-111111111111';
const replyId = '22222222-2222-4222-8222-222222222222';
const mediaId = '33333333-3333-4333-8333-333333333333';
const actionTs = Date.parse('2026-07-01T12:00:00.000Z');

const userKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const userPublicKey = userKeys.publicKey
  .export({ type: 'spki', format: 'der' })
  .toString('base64');
const userDid = generateDID(userPublicKey);

function userAction() {
  // This fixture is a historical v2 proof; its signed handle must stay byte-for-byte bare.
  const unsigned = {
    action: 'post',
    data: {
      clientPostId: replyId,
      content: 'Portable reply',
      mediaIds: [mediaId],
      mediaManifest: [{
        id: mediaId,
        url: 'https://stuffbox.xyz/reply.jpg',
        altText: 'Reply attachment',
        mimeType: 'image/jpeg',
      }],
      linkPreview: null,
      swarmReplyTo: {
        postId: parentPostId,
        nodeDomain: 'relay.social',
      },
      isNsfw: false,
    },
    did: userDid,
    handle: 'alice',
    ts: actionTs,
    nonce: 'portable_reply_nonce',
  };
  const signer = crypto.createSign('SHA256');
  signer.update(canonicalize(unsigned));
  signer.end();
  return {
    ...unsigned,
    sig: signer.sign({
      key: userKeys.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url'),
  };
}

function payload() {
  return {
    federation: {
      protocol: 'synapsis-federation-action-v2' as const,
      sourceDomain: 'author.social',
      destinationDomain: 'relay.social',
      method: 'POST' as const,
      path: '/api/swarm/replies',
      issuedAt: actionTs + 1_000,
      expiresAt: actionTs + 61_000,
    },
    userAction: userAction(),
    postId: parentPostId,
    reply: {
      id: replyId,
      content: 'Portable reply',
      createdAt: new Date(actionTs + 2_000).toISOString(),
      author: {
        handle: 'alice',
        displayName: 'Alice',
        avatarUrl: 'https://stuffbox.xyz/alice.png',
        did: userDid,
        publicKey: userPublicKey,
        isNsfw: false,
      },
      nodeDomain: 'author.social',
      nodeIsNsfw: false,
      isNsfw: false,
      mediaUrls: ['https://stuffbox.xyz/reply.jpg'],
    },
  };
}

const badge = {
  level: 'supporter' as const,
  plan: 'mini' as const,
  issuer: 'https://stuffbox.xyz',
  attestation: 'x'.repeat(100),
  expiresAt: '2026-07-02T12:00:00.000Z',
};

function presentation(overrides: Record<string, unknown> = {}) {
  return {
    id: replyId,
    content: 'Portable reply',
    createdAt: new Date(actionTs).toISOString(),
    nodeDomain: 'author.social',
    author: { handle: 'alice' },
    media: [{
      url: 'https://stuffbox.xyz/reply.jpg',
      altText: 'Reply attachment',
      mimeType: 'image/jpeg',
    }],
    isNsfw: false,
    nodeIsNsfw: false,
    ...overrides,
  };
}

describe('portable federated reply provenance', () => {
  it('verifies historical node provenance and the self-certifying author proof', async () => {
    const originalPayload = payload();
    const verifyNodeProof = vi.fn().mockResolvedValue(true);
    const verified = await verifyRelayedReplyProvenance({
      provenance: createRelayedReplyProvenance(originalPayload, 'bm9kZV9zaWduYXR1cmU='),
      relayDomain: 'relay.social',
      expectedParentPostId: parentPostId,
      presentation: presentation(),
      verifyNodeProof,
    });

    expect(verifyNodeProof).toHaveBeenCalledWith(
      originalPayload,
      'bm9kZV9zaWduYXR1cmU=',
      'author.social',
    );
    expect(verified).toMatchObject({
      id: replyId,
      content: 'Portable reply',
      createdAt: new Date(actionTs).toISOString(),
      nodeDomain: 'author.social',
      authorDid: userDid,
      authorHandle: 'alice@author.social',
      authorDisplayName: 'Alice',
      authorAvatarUrl: 'https://stuffbox.xyz/alice.png',
      isNsfw: false,
      nodeIsNsfw: false,
      media: [{ url: 'https://stuffbox.xyz/reply.jpg' }],
    });
  });

  it('rejects relay edits to signed content or media', async () => {
    const proof = createRelayedReplyProvenance(payload(), 'bm9kZV9zaWduYXR1cmU=');
    const verifyNodeProof = vi.fn().mockResolvedValue(true);

    await expect(verifyRelayedReplyProvenance({
      provenance: proof,
      relayDomain: 'relay.social',
      expectedParentPostId: parentPostId,
      presentation: presentation({ content: 'Edited by relay' }),
      verifyNodeProof,
    })).resolves.toBeNull();
    await expect(verifyRelayedReplyProvenance({
      provenance: proof,
      relayDomain: 'relay.social',
      expectedParentPostId: parentPostId,
      presentation: presentation({ media: [] }),
      verifyNodeProof,
    })).resolves.toBeNull();
    expect(verifyNodeProof).not.toHaveBeenCalled();
  });

  it('rejects a proof replayed under another parent or relay node', async () => {
    const proof = createRelayedReplyProvenance(payload(), 'bm9kZV9zaWduYXR1cmU=');
    const verifyNodeProof = vi.fn().mockResolvedValue(true);

    await expect(verifyRelayedReplyProvenance({
      provenance: proof,
      relayDomain: 'evil-relay.social',
      expectedParentPostId: parentPostId,
      presentation: presentation(),
      verifyNodeProof,
    })).resolves.toBeNull();
    await expect(verifyRelayedReplyProvenance({
      provenance: proof,
      relayDomain: 'relay.social',
      expectedParentPostId: '44444444-4444-4444-8444-444444444444',
      presentation: presentation(),
      verifyNodeProof,
    })).resolves.toBeNull();
    expect(verifyNodeProof).not.toHaveBeenCalled();
  });

  it('rejects invalid node or user signatures', async () => {
    const originalPayload = payload();
    const proof = createRelayedReplyProvenance(originalPayload, 'bm9kZV9zaWduYXR1cmU=');
    await expect(verifyRelayedReplyProvenance({
      provenance: proof,
      relayDomain: 'relay.social',
      expectedParentPostId: parentPostId,
      presentation: presentation(),
      verifyNodeProof: vi.fn().mockResolvedValue(false),
    })).resolves.toBeNull();

    originalPayload.userAction.data.content = 'Tampered after signing';
    await expect(verifyRelayedReplyProvenance({
      provenance: createRelayedReplyProvenance(originalPayload, 'bm9kZV9zaWduYXR1cmU='),
      relayDomain: 'relay.social',
      expectedParentPostId: parentPostId,
      presentation: presentation({ content: 'Tampered after signing' }),
      verifyNodeProof: vi.fn().mockResolvedValue(true),
    })).resolves.toBeNull();
  });

  it('rejects unrecognized signed fields instead of storing padded proofs', async () => {
    const originalPayload = payload();
    Object.assign(originalPayload.userAction.data, { attackerPadding: 'x'.repeat(1_000) });
    const verifyNodeProof = vi.fn().mockResolvedValue(true);

    await expect(verifyRelayedReplyProvenance({
      provenance: createRelayedReplyProvenance(originalPayload, 'bm9kZV9zaWduYXR1cmU='),
      relayDomain: 'relay.social',
      expectedParentPostId: parentPostId,
      presentation: presentation(),
      verifyNodeProof,
    })).resolves.toBeNull();
    expect(verifyNodeProof).not.toHaveBeenCalled();
  });

  it('accepts the optional badge proof and independently binds it to the reply author', async () => {
    const originalPayload = payload();
    Object.assign(originalPayload.reply.author, { stuffboxBadge: badge });
    const verifyBadgeProof = vi.fn().mockResolvedValue(badge);

    const verified = await verifyRelayedReplyProvenance({
      provenance: createRelayedReplyProvenance(originalPayload, 'bm9kZV9zaWduYXR1cmU='),
      relayDomain: 'relay.social',
      expectedParentPostId: parentPostId,
      presentation: presentation(),
      verifyNodeProof: vi.fn().mockResolvedValue(true),
      verifyBadgeProof,
    });

    expect(verifyBadgeProof).toHaveBeenCalledWith(badge.attestation, 'alice@author.social');
    expect(verified?.stuffboxBadge).toEqual(badge);
  });
});
