import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateDID } from '@/lib/crypto/did-key';
import { canonicalize } from '@/lib/crypto/user-signing';
import { createRelayedReplyProvenance } from './reply-provenance';
import {
  applyAuthenticatedProfileNodeClassification,
  parseRemotePostDetailResponse,
  parseRemotePostListResponse,
  parseRemoteProfileResponse,
  parseRemoteRepliesResponse,
} from './remote-post-payload';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const signingKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const did = generateDID(signingKey);

function portableReply(parentPostId: string) {
  // This fixture is a historical v2 proof; its signed handle must stay byte-for-byte bare.
  const replyId = '22222222-2222-4222-8222-222222222222';
  const ts = Date.now() - 60_000;
  const unsignedAction = {
    action: 'post',
    data: {
      clientPostId: replyId,
      content: 'Proven third-party reply',
      mediaIds: [],
      mediaManifest: [],
      swarmReplyTo: { postId: parentPostId, nodeDomain: 'source.social' },
      isNsfw: false,
    },
    did,
    handle: 'alice',
    ts,
    nonce: 'portable_reply_nonce',
  };
  const signer = crypto.createSign('SHA256');
  signer.update(canonicalize(unsignedAction));
  signer.end();
  const userAction = {
    ...unsignedAction,
    sig: signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'),
  };
  const payload = {
    federation: {
      protocol: 'synapsis-federation-action-v2' as const,
      sourceDomain: 'author.social',
      destinationDomain: 'source.social',
      method: 'POST' as const,
      path: '/api/swarm/replies',
      issuedAt: ts + 1_000,
      expiresAt: ts + 61_000,
    },
    userAction,
    postId: parentPostId,
    reply: {
      id: replyId,
      content: 'Proven third-party reply',
      createdAt: new Date(ts + 2_000).toISOString(),
      author: { handle: 'alice', did, publicKey: signingKey, isNsfw: false },
      nodeDomain: 'author.social',
      nodeIsNsfw: false,
      isNsfw: false,
      mediaUrls: [],
    },
  };
  return {
    id: replyId,
    content: 'Proven third-party reply',
    createdAt: new Date(ts).toISOString(),
    nodeDomain: 'author.social',
    isNsfw: false,
    nodeIsNsfw: false,
    likeCount: 2,
    repostCount: 3,
    replyCount: 4,
    author: { handle: 'alice', displayName: 'Relay edit', isNsfw: false },
    media: [],
    provenance: createRelayedReplyProvenance(payload, 'bm9kZV9zaWduYXR1cmU='),
  };
}

function post(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    content: 'Hello',
    createdAt: new Date().toISOString(),
    isNsfw: false,
    nodeIsNsfw: false,
    likesCount: 0,
    repostsCount: 0,
    repliesCount: 0,
    nodeDomain: 'source.social',
    author: {
      handle: 'alice',
      displayName: 'Alice',
      isNsfw: false,
      nodeIsNsfw: false,
      nodeDomain: 'source.social',
    },
    ...overrides,
  };
}

function profileResponse(posts: unknown[] = [post()]) {
  return {
    profile: {
      handle: 'alice',
      displayName: 'Alice',
      followersCount: 1,
      followingCount: 2,
      postsCount: posts.length,
      createdAt: new Date().toISOString(),
      isNsfw: false,
      nodeIsNsfw: false,
      nodeDomain: 'source.social',
      publicKey: signingKey,
      did,
    },
    posts,
    nodeDomain: 'source.social',
    timestamp: new Date().toISOString(),
  };
}

describe('remote profile and post validation', () => {
  it('accepts bounded source-owned profile data with a self-certifying identity', () => {
    const result = parseRemoteProfileResponse(profileResponse(), 'source.social', 'alice', 25);
    expect(result.posts).toHaveLength(1);
    expect(result.profile.publicKey).toBe(signingKey);
  });

  it('uses an authenticated safe profile classification for its post and author', () => {
    const parsed = parseRemoteProfileResponse(profileResponse([
      post({
        nodeIsNsfw: undefined,
        author: {
          handle: 'alice',
          displayName: 'Alice',
          isNsfw: false,
          nodeIsNsfw: undefined,
          nodeDomain: 'source.social',
        },
      }),
    ]), 'source.social', 'alice');

    expect(parsed.posts[0].nodeIsNsfw).toBe(true);
    expect(parsed.posts[0].author.nodeIsNsfw).toBe(true);

    const classified = applyAuthenticatedProfileNodeClassification(
      parsed.posts[0],
      parsed.profile.nodeIsNsfw,
    );
    expect(classified.nodeIsNsfw).toBe(false);
    expect(classified.author.nodeIsNsfw).toBe(false);
  });

  it('drops cross-node post attribution and deeper recursive payloads', () => {
    const forged = post({ nodeDomain: 'victim.social' });
    const recursive = post({
      repostOf: post({ repostOf: post() }),
    });
    const result = parseRemoteProfileResponse(profileResponse([forged, recursive]), 'source.social', 'alice', 25);
    expect(result.posts).toHaveLength(1);
    expect((result.posts[0].repostOf as unknown as { repostOf?: unknown }).repostOf).toBeUndefined();
  });

  it('preserves a validated direct reply parent without trusting deeper or cross-node context', () => {
    const replyParent = post({
      id: '33333333-3333-4333-8333-333333333333',
      content: 'Parent post',
      author: {
        handle: 'bob',
        displayName: 'Bob',
        isNsfw: false,
        nodeIsNsfw: false,
        nodeDomain: 'source.social',
      },
      replyTo: post(),
    });
    const reply = post({
      id: '22222222-2222-4222-8222-222222222222',
      content: 'Reply',
      isReply: true,
      replyToId: replyParent.id,
      replyTo: replyParent,
    });

    const result = parseRemoteProfileResponse(profileResponse([reply]), 'source.social', 'alice', 25);
    expect(result.posts[0].replyTo).toMatchObject({
      id: replyParent.id,
      content: 'Parent post',
      nodeDomain: 'source.social',
      author: { handle: 'bob@source.social', nodeDomain: 'source.social' },
    });
    expect((result.posts[0].replyTo as unknown as { replyTo?: unknown }).replyTo).toBeUndefined();

    const forgedParent = post({
      nodeDomain: 'victim.social',
      author: { handle: 'bob@victim.social', nodeDomain: 'victim.social' },
    });
    const forgedReply = post({ replyTo: forgedParent });
    const filtered = parseRemoteProfileResponse(profileResponse([forgedReply]), 'source.social', 'alice', 25);
    expect(filtered.posts).toEqual([]);
  });

  it('rejects copied or mismatched DID/key identities', () => {
    const payload = profileResponse();
    payload.profile.did = 'did:key:not-the-signing-key';
    expect(() => parseRemoteProfileResponse(payload, 'source.social', 'alice')).toThrow(/not bound/);
  });

  it('bounds arrays and validates direct post identity', () => {
    expect(() => parseRemoteProfileResponse(
      profileResponse(Array.from({ length: 51 }, () => post())),
      'source.social',
      'alice',
    )).toThrow(/failed validation/);
    expect(() => parseRemotePostDetailResponse(
      { post: post() },
      'source.social',
      '22222222-2222-4222-8222-222222222222',
    )).toThrow(/different post/);
  });

  it('filters relayed replies that are not owned by the contacted origin', async () => {
    const replies = await parseRemoteRepliesResponse({
      postId: '11111111-1111-4111-8111-111111111111',
      nodeDomain: 'source.social',
      replies: [post(), post({ nodeDomain: 'victim.social' })],
    }, 'source.social', '11111111-1111-4111-8111-111111111111');
    expect(replies).toHaveLength(1);
  });

  it('accepts a cross-node reply only with portable node and user provenance', async () => {
    const parentPostId = '11111111-1111-4111-8111-111111111111';
    const replies = await parseRemoteRepliesResponse({
      postId: parentPostId,
      nodeDomain: 'source.social',
      replies: [portableReply(parentPostId)],
    }, 'source.social', parentPostId, {
      verifyNodeProof: async () => true,
      verifyIdentityContinuity: async () => true,
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      id: '22222222-2222-4222-8222-222222222222',
      content: 'Proven third-party reply',
      nodeDomain: 'author.social',
      likesCount: 2,
      author: {
        handle: 'alice@author.social',
        displayName: 'alice@author.social',
        nodeDomain: 'author.social',
      },
    });

    const conflictingIdentity = await parseRemoteRepliesResponse({
      postId: parentPostId,
      nodeDomain: 'source.social',
      replies: [portableReply(parentPostId)],
    }, 'source.social', parentPostId, {
      verifyNodeProof: async () => true,
      verifyIdentityContinuity: async () => false,
    });
    expect(conflictingIdentity).toEqual([]);
  });

  it('bounds profile activity lists and drops unsigned third-party objects', () => {
    const posts = parseRemotePostListResponse({
      posts: [post(), post({ nodeDomain: 'victim.social' })],
    }, 'source.social', 25);
    expect(posts).toHaveLength(1);
    expect(posts[0].nodeDomain).toBe('source.social');

    expect(() => parseRemotePostListResponse({
      posts: Array.from({ length: 51 }, () => post()),
    }, 'source.social')).toThrow(/failed validation/);
  });
});
