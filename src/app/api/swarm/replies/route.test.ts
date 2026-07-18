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
  verifyFederatedUserAction: vi.fn(),
  pinVerifiedFederatedActorIdentity: vi.fn(),
  isTrustedFederationRead: vi.fn(),
  requireClassification: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: {
    query: { posts: { findFirst: mocks.findFirst } },
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
    nodeId: 'users.nodeId',
  },
  media: {},
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
  isTrustedFederationRead: mocks.isTrustedFederationRead,
}));
vi.mock('@/lib/node/local-node', () => ({
  requireLocalNodeNsfwClassification: mocks.requireClassification,
}));
vi.mock('@/lib/swarm/user-cache', () => ({ upsertRemoteUser: vi.fn() }));

import { DELETE, GET } from './route';

const replyId = '15f11861-693a-4f70-8480-5d82bb8d14a7';
const parentId = '25f11861-693a-4f70-8480-5d82bb8d14a7';
const authorDid = 'did:key:zAliceSigningKey';
const actionIssuedAt = Date.now();
const deletionTimestamp = new Date().toISOString();

function deletionUserAction(postId = replyId) {
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

describe('swarm reply authorization and sensitivity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireClassification.mockResolvedValue(false);
    mocks.isTrustedFederationRead.mockResolvedValue(false);
    mocks.verifyFederatedUserAction.mockResolvedValue({
      ok: false,
      status: 403,
      error: 'Invalid user signature',
    });
    mocks.pinVerifiedFederatedActorIdentity.mockResolvedValue({
      sourceDomain: 'source.social',
      actorHandle: 'alice',
      qualifiedHandle: 'alice@source.social',
      did: authorDid,
    });
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
    mocks.txInsertValues.mockReturnValue({ onConflictDoNothing: mocks.txInsertOnConflict });
    mocks.txInsert.mockReturnValue({ values: mocks.txInsertValues });
    mocks.txDeleteWhere.mockResolvedValue(undefined);
    mocks.txDelete.mockReturnValue({ where: mocks.txDeleteWhere });
    mocks.transaction.mockImplementation(async (callback) => callback({
      insert: mocks.txInsert,
      delete: mocks.txDelete,
    }));
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
      actorHandle: 'alice',
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
      actorHandle: 'alice',
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
      author: { handle: 'local-author', nodeId: null, isNsfw: false },
    });
    const response = await GET(new Request(
      `https://target.social/api/swarm/replies?postId=${parentId}`,
    ) as never);

    expect(response.status).toBe(403);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('filters a bare-handle remote reply with a node id from an unsigned safe thread', async () => {
    mocks.findFirst.mockResolvedValue({
      id: parentId,
      isNsfw: false,
      author: { handle: 'local-author', nodeId: null, isNsfw: false },
    });
    mocks.limit.mockResolvedValue([{
      id: replyId,
      content: 'REMOTE SECRET BODY',
      createdAt: new Date('2026-07-17T00:00:00.000Z'),
      likesCount: 0,
      repostsCount: 0,
      repliesCount: 0,
      authorHandle: 'legacy_remote',
      authorDisplayName: 'Legacy remote',
      authorAvatarUrl: 'https://remote.social/secret-avatar.jpg',
      authorIsNsfw: false,
      authorNodeId: 'remote-node-row',
      postIsNsfw: false,
    }]);
    const response = await GET(new Request(
      `https://target.social/api/swarm/replies?postId=${parentId}`,
    ) as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.replies).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('REMOTE SECRET BODY');
    expect(JSON.stringify(body)).not.toContain('secret-avatar.jpg');
  });

  it('returns a delivered reply under its source-node id to trusted peers', async () => {
    mocks.isTrustedFederationRead.mockResolvedValue(true);
    mocks.findFirst.mockResolvedValue({
      id: parentId,
      isNsfw: false,
      author: { handle: 'local-author', nodeId: null, isNsfw: false },
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
      authorNodeId: 'source-node-row',
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
        handle: 'alice',
        isNsfw: true,
      },
    });
  });
});
