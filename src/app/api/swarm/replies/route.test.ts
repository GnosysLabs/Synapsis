import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  select: vi.fn(),
  selectFrom: vi.fn(),
  selectWhere: vi.fn(),
  innerJoin: vi.fn(),
  joinedWhere: vi.fn(),
  orderBy: vi.fn(),
  limit: vi.fn(),
  update: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
  transaction: vi.fn(),
  txInsert: vi.fn(),
  txInsertValues: vi.fn(),
  txInsertOnConflict: vi.fn(),
  txInsertReturning: vi.fn(),
  txDelete: vi.fn(),
  txDeleteWhere: vi.fn(),
  txPostFindFirst: vi.fn(),
  txUserFindFirst: vi.fn(),
  verifyFederatedUserAction: vi.fn(),
  pinVerifiedFederatedActorIdentity: vi.fn(),
  shouldSuppressRemoteInteraction: vi.fn(),
  upsertRemoteUser: vi.fn(),
  signingPublicKeyFromDid: vi.fn(),
  authorizeFederationRead: vi.fn(),
  requireClassification: vi.fn(),
  verifyStuffboxBadgeAttestation: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: {
    query: {
      posts: { findFirst: mocks.findFirst },
    },
    select: mocks.select,
    update: mocks.update,
    transaction: mocks.transaction,
  },
  posts: {
    id: 'posts.id',
    apId: 'posts.apId',
    replyToId: 'posts.replyToId',
    isRemoved: 'posts.isRemoved',
    userId: 'posts.userId',
    content: 'posts.content',
    createdAt: 'posts.createdAt',
    likesCount: 'posts.likesCount',
    repostsCount: 'posts.repostsCount',
    repliesCount: 'posts.repliesCount',
    isNsfw: 'posts.isNsfw',
  },
  users: {
    id: 'users.id',
    handle: 'users.handle',
    displayName: 'users.displayName',
    avatarUrl: 'users.avatarUrl',
    isNsfw: 'users.isNsfw',
    homeDomain: 'users.homeDomain',
    isLocalAccount: 'users.isLocalAccount',
  },
  media: {
    id: 'media.id',
    postId: 'media.postId',
    url: 'media.url',
    altText: 'media.altText',
    mimeType: 'media.mimeType',
  },
  notifications: {},
  swarmInboundActions: {
    id: 'swarmInboundActions.id',
    sourceDomain: 'swarmInboundActions.sourceDomain',
    action: 'swarmInboundActions.action',
    interactionId: 'swarmInboundActions.interactionId',
  },
  handleRegistry: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((field, value) => ({ op: 'eq', field, value })),
  desc: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  inArray: vi.fn((field, values) => ({ op: 'inArray', field, values })),
  sql: vi.fn(() => ({})),
}));

vi.mock('@/lib/swarm/federated-action', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/swarm/federated-action')>();
  return {
    ...actual,
    verifyFederatedUserAction: mocks.verifyFederatedUserAction,
    pinVerifiedFederatedActorIdentity: mocks.pinVerifiedFederatedActorIdentity,
  };
});
vi.mock('@/lib/swarm/signed-read', () => ({
  authorizeFederationRead: mocks.authorizeFederationRead,
  federationReadFailureResponse: (authorization: { status: number; code: string; error: string }) =>
    Response.json({ error: authorization.error, code: authorization.code }, { status: authorization.status }),
}));
vi.mock('@/lib/node/local-node', () => ({
  requireLocalNodeNsfwClassification: mocks.requireClassification,
}));
vi.mock('@/lib/swarm/user-cache', () => ({ upsertRemoteUser: mocks.upsertRemoteUser }));
vi.mock('@/lib/swarm/remote-interaction-policy', () => ({
  shouldSuppressRemoteInteraction: mocks.shouldSuppressRemoteInteraction,
}));
vi.mock('@/lib/crypto/did-key', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/crypto/did-key')>();
  return {
    ...actual,
    signingPublicKeyFromDid: mocks.signingPublicKeyFromDid,
  };
});
vi.mock('@/lib/stuffbox/badge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/stuffbox/badge')>();
  return {
    ...actual,
    verifyStuffboxBadgeAttestation: mocks.verifyStuffboxBadgeAttestation,
  };
});

import { DELETE, GET, POST } from './route';

const replyId = '15f11861-693a-4f70-8480-5d82bb8d14a7';
const parentId = '25f11861-693a-4f70-8480-5d82bb8d14a7';
const authorDid = 'did:key:zAliceSigningKey';
const actionIssuedAt = Date.now();
const deletionTimestamp = new Date().toISOString();

function deletionUserAction(postId = replyId) {
  // Historical v2 proofs keep their exact bare signed handles.
  return {
    action: 'delete',
    data: { postId },
    did: authorDid,
    handle: 'alice',
    ts: actionIssuedAt,
    nonce: 'delete_nonce_123',
    sig: 'delete_signature_123',
  };
}

function deletionPayload(nodeDomain = 'source.social') {
  return {
    federation: {
      protocol: 'synapsis-federation-action-v2' as const,
      sourceDomain: 'source.social',
      destinationDomain: 'target.social',
      method: 'DELETE' as const,
      path: '/api/swarm/replies',
      issuedAt: actionIssuedAt,
      expiresAt: actionIssuedAt + 60_000,
    },
    userAction: deletionUserAction(),
    replyId,
    nodeDomain,
    authorHandle: 'alice',
    timestamp: deletionTimestamp,
  };
}

function deleteRequest(headers: Record<string, string> = {}, nodeDomain = 'source.social') {
  return new Request('https://target.social/api/swarm/replies', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(deletionPayload(nodeDomain)),
  });
}

function replyUserAction() {
  return {
    action: 'post',
    data: {
      clientPostId: replyId,
      content: 'Federated reply',
      swarmReplyTo: {
        postId: parentId,
        nodeDomain: 'target.social',
      },
      isNsfw: false,
    },
    did: authorDid,
    handle: 'alice',
    ts: actionIssuedAt,
    nonce: 'reply_nonce_123',
    sig: 'reply_signature_123',
  };
}

function replyPayload(badge?: Record<string, unknown>) {
  return {
    federation: {
      protocol: 'synapsis-federation-action-v2' as const,
      sourceDomain: 'source.social',
      destinationDomain: 'target.social',
      method: 'POST' as const,
      path: '/api/swarm/replies',
      issuedAt: actionIssuedAt,
      expiresAt: actionIssuedAt + 60_000,
    },
    userAction: replyUserAction(),
    postId: parentId,
    reply: {
      id: replyId,
      content: 'Federated reply',
      createdAt: new Date(actionIssuedAt).toISOString(),
      author: {
        handle: 'alice',
        displayName: 'Alice',
        did: authorDid,
        isNsfw: false,
        ...(badge ? { stuffboxBadge: badge } : {}),
      },
      nodeDomain: 'source.social',
      nodeIsNsfw: false,
      isNsfw: false,
      mediaUrls: [],
    },
  };
}

function replyRequest(badge?: Record<string, unknown>) {
  return new Request('https://target.social/api/swarm/replies', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Swarm-Source-Domain': 'source.social',
      'X-Swarm-Signature': 'signed',
    },
    body: JSON.stringify(replyPayload(badge)),
  });
}

describe('swarm reply authorization and sensitivity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireClassification.mockResolvedValue(false);
    mocks.authorizeFederationRead.mockResolvedValue({
      ok: false, status: 401, code: 'FEDERATION_AUTH_REQUIRED', error: 'Authenticated federation read required',
    });
    mocks.verifyFederatedUserAction.mockResolvedValue({
      ok: false,
      status: 403,
      error: 'Invalid user signature',
    });
    mocks.pinVerifiedFederatedActorIdentity.mockResolvedValue({
      sourceDomain: 'source.social',
      actorHandle: 'alice@source.social',
      qualifiedHandle: 'alice@source.social',
      did: authorDid,
    });
    mocks.signingPublicKeyFromDid.mockReturnValue('verified-signing-public-key');
    mocks.upsertRemoteUser.mockResolvedValue(undefined);
    mocks.shouldSuppressRemoteInteraction.mockResolvedValue(false);
    mocks.verifyStuffboxBadgeAttestation.mockResolvedValue(null);
    mocks.findFirst.mockResolvedValue(null);
    mocks.limit.mockResolvedValue([]);
    mocks.orderBy.mockReturnValue({ limit: mocks.limit });
    mocks.joinedWhere.mockReturnValue({ orderBy: mocks.orderBy });
    mocks.innerJoin.mockReturnValue({ where: mocks.joinedWhere });
    mocks.selectWhere.mockResolvedValue([{ count: 0 }]);
    mocks.selectFrom.mockReturnValue({
      innerJoin: mocks.innerJoin,
      where: mocks.selectWhere,
    });
    mocks.select.mockReturnValue({ from: mocks.selectFrom });
    mocks.updateWhere.mockResolvedValue(undefined);
    mocks.updateSet.mockReturnValue({ where: mocks.updateWhere });
    mocks.update.mockReturnValue({ set: mocks.updateSet });
    mocks.txInsertReturning.mockResolvedValue([{ id: 'inbound-claim' }]);
    mocks.txInsertOnConflict.mockReturnValue({ returning: mocks.txInsertReturning });
    mocks.txInsertValues.mockReturnValue({
      onConflictDoNothing: mocks.txInsertOnConflict,
      returning: mocks.txInsertReturning,
    });
    mocks.txInsert.mockReturnValue({ values: mocks.txInsertValues });
    mocks.txDeleteWhere.mockResolvedValue(undefined);
    mocks.txDelete.mockReturnValue({ where: mocks.txDeleteWhere });
    mocks.transaction.mockImplementation(async (callback) => callback({
      insert: mocks.txInsert,
      delete: mocks.txDelete,
      query: {
        posts: { findFirst: mocks.txPostFindFirst },
        users: { findFirst: mocks.txUserFindFirst },
      },
    }));
  });

  it('rolls an authoritative reply-ID conflict back before materializing its actor', async () => {
    mocks.verifyFederatedUserAction.mockResolvedValue({
      ok: true,
      actorHandle: 'alice@source.social',
      actorUsername: 'alice',
      sourceDomain: 'source.social',
      destinationDomain: 'target.social',
      userAction: replyUserAction(),
      replayId: 'reply-replay-id',
    });
    mocks.findFirst
      .mockResolvedValueOnce({
        id: parentId,
        userId: 'parent-user-id',
        isRemoved: false,
        author: {
          handle: 'owner@target.social',
          username: 'owner',
          homeDomain: 'target.social',
          isLocalAccount: true,
        },
      })
      .mockResolvedValueOnce(null);
    mocks.txPostFindFirst.mockResolvedValue({
      id: 'winning-reply',
      content: 'Federated reply',
      author: { did: 'did:key:zWinningActor' },
    });

    const response = await POST(replyRequest() as never);

    expect(response.status).toBe(409);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.pinVerifiedFederatedActorIdentity).not.toHaveBeenCalled();
    expect(mocks.upsertRemoteUser).not.toHaveBeenCalled();
  });

  it('accepts a policy-suppressed remote reply without identity, replay, or state writes', async () => {
    mocks.verifyFederatedUserAction.mockResolvedValue({
      ok: true,
      actorHandle: 'alice@source.social',
      actorUsername: 'alice',
      sourceDomain: 'source.social',
      destinationDomain: 'target.social',
      userAction: replyUserAction(),
      replayId: 'reply-replay-id',
    });
    mocks.findFirst
      .mockResolvedValueOnce({
        id: parentId,
        userId: 'parent-user-id',
        isRemoved: false,
        author: {
          handle: 'owner@target.social',
          username: 'owner',
          homeDomain: 'target.social',
          isLocalAccount: true,
        },
      })
      .mockResolvedValueOnce(null);
    mocks.shouldSuppressRemoteInteraction.mockResolvedValue(true);

    const response = await POST(replyRequest() as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      message: 'Reply received',
    });
    expect(mocks.shouldSuppressRemoteInteraction).toHaveBeenCalledWith(
      'parent-user-id',
      {
        did: authorDid,
        handle: 'alice@source.social',
        domain: 'source.social',
      },
    );
    expect(mocks.signingPublicKeyFromDid).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.pinVerifiedFederatedActorIdentity).not.toHaveBeenCalled();
    expect(mocks.upsertRemoteUser).not.toHaveBeenCalled();
  });

  it('accepts the optional badge contract and stores only its independently verified result', async () => {
    const badge = {
      level: 'supporter',
      plan: 'mini',
      issuer: 'https://stuffbox.xyz',
      attestation: 'x'.repeat(100),
      expiresAt: '2026-07-22T00:00:00.000Z',
    };
    mocks.verifyFederatedUserAction.mockResolvedValue({
      ok: true,
      actorHandle: 'alice@source.social',
      actorUsername: 'alice',
      sourceDomain: 'source.social',
      destinationDomain: 'target.social',
      userAction: replyUserAction(),
      replayId: 'reply-replay-id',
    });
    mocks.findFirst
      .mockResolvedValueOnce({
        id: parentId,
        userId: 'parent-user-id',
        isRemoved: false,
        author: {
          handle: 'owner@target.social',
          username: 'owner',
          homeDomain: 'target.social',
          isLocalAccount: true,
        },
      })
      .mockResolvedValueOnce(null);
    mocks.txPostFindFirst.mockResolvedValue(null);
    mocks.txUserFindFirst.mockResolvedValue({ id: 'remote-user-id', did: authorDid });
    mocks.verifyStuffboxBadgeAttestation.mockResolvedValue(badge);

    const response = await POST(replyRequest(badge) as never);

    expect(response.status).toBe(200);
    expect(mocks.verifyStuffboxBadgeAttestation).toHaveBeenCalledWith(
      badge.attestation,
      'alice@source.social',
    );
    expect(mocks.upsertRemoteUser).toHaveBeenCalledWith(expect.objectContaining({
      handle: 'alice@source.social',
      stuffboxBadge: badge,
    }), { identityVerified: true }, expect.anything());
  });

  it('rejects unsigned deletion before reading or mutating a reply', async () => {
    const response = await DELETE(deleteRequest() as never);

    expect(response.status).toBe(401);
    expect(mocks.verifyFederatedUserAction).not.toHaveBeenCalled();
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('rejects an invalid double-signed deletion proof', async () => {
    const response = await DELETE(deleteRequest({
      'X-Swarm-Source-Domain': 'source.social',
      'X-Swarm-Signature': 'bad',
    }) as never);

    expect(response.status).toBe(403);
    expect(mocks.verifyFederatedUserAction).toHaveBeenCalledWith({
      payload: deletionPayload(),
      nodeSignature: 'bad',
      sourceDomain: 'source.social',
      expectedMethod: 'DELETE',
      expectedPath: '/api/swarm/replies',
      expectedAction: 'delete',
      actorHandle: 'alice',
      replayBinding: { replyId },
      maxActionsPerMinute: 30,
    });
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('rejects a deletion whose node header and payload source disagree', async () => {
    const response = await DELETE(deleteRequest({
      'X-Swarm-Source-Domain': 'other.social',
      'X-Swarm-Signature': 'signed',
    }) as never);

    expect(response.status).toBe(403);
    expect(mocks.verifyFederatedUserAction).not.toHaveBeenCalled();
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it('rejects deletion when the verified DID does not own the stored reply', async () => {
    mocks.verifyFederatedUserAction.mockResolvedValue({
      ok: true,
      actorHandle: 'alice@source.social',
      actorUsername: 'alice',
      sourceDomain: 'source.social',
      destinationDomain: 'target.social',
      userAction: deletionUserAction(),
      replayId: 'deletion-replay-id',
    });
    mocks.findFirst.mockResolvedValue({
      id: 'stored-reply',
      replyToId: parentId,
      author: {
        did: 'did:key:zDifferentSigningKey',
        handle: 'alice@source.social',
      },
    });

    const response = await DELETE(deleteRequest({
      'X-Swarm-Source-Domain': 'source.social',
      'X-Swarm-Signature': 'signed',
    }) as never);

    expect(response.status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.txDelete).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('deletes only the signed source namespace and resynchronizes its parent', async () => {
    mocks.verifyFederatedUserAction.mockResolvedValue({
      ok: true,
      actorHandle: 'alice@source.social',
      actorUsername: 'alice',
      sourceDomain: 'source.social',
      destinationDomain: 'target.social',
      userAction: deletionUserAction(),
      replayId: 'deletion-replay-id',
    });
    mocks.findFirst.mockResolvedValue({
      id: 'stored-reply',
      replyToId: parentId,
      author: {
        did: authorDid,
        handle: 'alice@source.social',
      },
    });
    mocks.selectWhere.mockResolvedValue([{ count: 4 }]);

    const response = await DELETE(deleteRequest({
      'X-Swarm-Source-Domain': 'source.social',
      'X-Swarm-Signature': 'signed',
    }) as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, replayed: false });
    expect(mocks.verifyFederatedUserAction).toHaveBeenCalledWith(expect.objectContaining({
      payload: deletionPayload(),
      nodeSignature: 'signed',
      sourceDomain: 'source.social',
      expectedMethod: 'DELETE',
      expectedPath: '/api/swarm/replies',
      expectedAction: 'delete',
      actorHandle: 'alice',
      replayBinding: { replyId },
    }));
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { apId: `swarm:source.social:${replyId}` },
      with: { author: true },
    });
    expect(mocks.txInsertValues).toHaveBeenCalledWith({
      sourceDomain: 'source.social',
      action: 'delete_reply',
      interactionId: 'deletion-replay-id',
    });
    expect(mocks.txDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'posts.id' }));
    expect(mocks.txDeleteWhere).toHaveBeenCalledWith({
      op: 'eq',
      field: 'posts.id',
      value: 'stored-reply',
    });
    expect(mocks.updateSet).toHaveBeenCalledWith({ repliesCount: 4 });
    expect(mocks.updateWhere).toHaveBeenCalledWith({
      op: 'eq',
      field: 'posts.id',
      value: parentId,
    });
  });

  it('denies an unsigned sensitive parent thread', async () => {
    mocks.findFirst.mockResolvedValue({
      id: parentId,
      isNsfw: true,
      author: {
        handle: 'local-author@target.social',
        username: 'local-author',
        homeDomain: 'target.social',
        isLocalAccount: true,
        isNsfw: false,
      },
    });
    const response = await GET(new Request(
      `https://target.social/api/swarm/replies?postId=${parentId}`,
    ) as never);

    expect(response.status).toBe(401);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('does not expose a safe thread to an unsigned caller', async () => {
    mocks.findFirst.mockResolvedValue({
      id: parentId,
      isNsfw: false,
      author: {
        handle: 'local-author@target.social',
        username: 'local-author',
        homeDomain: 'target.social',
        isLocalAccount: true,
        isNsfw: false,
      },
    });
    mocks.limit.mockResolvedValue([{
      id: replyId,
      content: 'REMOTE SECRET BODY',
      createdAt: new Date('2026-07-17T00:00:00.000Z'),
      likesCount: 0,
      repostsCount: 0,
      repliesCount: 0,
      authorHandle: 'legacy_remote@remote.social',
      authorDisplayName: 'Legacy remote',
      authorAvatarUrl: 'https://remote.social/secret-avatar.jpg',
      authorIsNsfw: false,
      authorHomeDomain: 'remote.social',
      authorIsLocalAccount: false,
      postIsNsfw: false,
    }]);
    const response = await GET(new Request(
      `https://target.social/api/swarm/replies?postId=${parentId}`,
    ) as never);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.replies).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('REMOTE SECRET BODY');
    expect(JSON.stringify(body)).not.toContain('secret-avatar.jpg');
  });

  it('returns a delivered reply under its source-node id to trusted peers', async () => {
    mocks.authorizeFederationRead.mockResolvedValue({ ok: true, sourceDomain: 'peer.example' });
    mocks.findFirst.mockResolvedValue({
      id: parentId,
      isNsfw: false,
      author: {
        handle: 'local-author@target.social',
        username: 'local-author',
        homeDomain: 'target.social',
        isLocalAccount: true,
        isNsfw: false,
      },
    });
    mocks.limit.mockResolvedValue([{
      id: 'origin-cache-row',
      apId: `swarm:source.social:${replyId}`,
      content: 'Federated reply',
      createdAt: new Date('2026-07-18T00:00:00.000Z'),
      likesCount: 2,
      repostsCount: 3,
      repliesCount: 4,
      authorHandle: 'alice@source.social',
      authorDisplayName: 'Alice',
      authorAvatarUrl: null,
      authorIsNsfw: true,
      authorHomeDomain: 'source.social',
      authorIsLocalAccount: false,
      postIsNsfw: true,
    }]);

    const response = await GET(new Request(
      `https://target.social/api/swarm/replies?postId=${parentId}`,
    ) as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.replies).toHaveLength(1);
    expect(body.replies[0]).toMatchObject({
      id: replyId,
      nodeDomain: 'source.social',
      likeCount: 2,
      repostCount: 3,
      replyCount: 4,
      isNsfw: true,
      author: {
        handle: 'alice@source.social',
        isNsfw: true,
      },
    });
  });

  it('includes stored media for replies authored on this node', async () => {
    mocks.authorizeFederationRead.mockResolvedValue({ ok: true, sourceDomain: 'peer.example' });
    mocks.findFirst.mockResolvedValue({
      id: parentId,
      isNsfw: false,
      author: {
        handle: 'local-author@target.social',
        username: 'local-author',
        homeDomain: 'target.social',
        isLocalAccount: true,
        isNsfw: false,
      },
    });
    mocks.limit.mockResolvedValue([{
      id: replyId,
      apId: null,
      content: '',
      createdAt: new Date('2026-07-20T00:00:00.000Z'),
      likesCount: 0,
      repostsCount: 0,
      repliesCount: 0,
      authorHandle: 'local-author@target.social',
      authorDisplayName: 'Local Author',
      authorAvatarUrl: null,
      authorIsNsfw: false,
      authorHomeDomain: 'target.social',
      authorIsLocalAccount: true,
      postIsNsfw: false,
    }]);
    mocks.selectWhere.mockResolvedValueOnce([{
      id: 'gif-media-id',
      postId: replyId,
      url: 'https://stuffbox.xyz/f/example-gif',
      altText: 'Reaction GIF',
      mimeType: 'image/gif',
    }]);

    const response = await GET(new Request(
      `https://target.social/api/swarm/replies?postId=${parentId}`,
    ) as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.replies[0].media).toEqual([{
      id: 'gif-media-id',
      url: 'https://stuffbox.xyz/f/example-gif',
      altText: 'Reaction GIF',
      mimeType: 'image/gif',
    }]);
  });
});
