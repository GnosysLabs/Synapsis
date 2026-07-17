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
  delete: vi.fn(),
  deleteWhere: vi.fn(),
  update: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
  verifySwarmRequest: vi.fn(),
  isTrustedFederationRead: vi.fn(),
  requireClassification: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: {
    query: { posts: { findFirst: mocks.findFirst } },
    select: mocks.select,
    delete: mocks.delete,
    update: mocks.update,
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
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
}));

vi.mock('@/lib/swarm/signature', () => ({
  verifySwarmRequest: mocks.verifySwarmRequest,
}));
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

function deleteRequest(headers: Record<string, string> = {}, nodeDomain = 'source.social') {
  return new Request('https://target.social/api/swarm/replies', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ replyId, nodeDomain, authorHandle: 'alice' }),
  });
}

describe('swarm reply authorization and sensitivity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireClassification.mockResolvedValue(false);
    mocks.isTrustedFederationRead.mockResolvedValue(false);
    mocks.verifySwarmRequest.mockResolvedValue(false);
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
    mocks.deleteWhere.mockResolvedValue(undefined);
    mocks.delete.mockReturnValue({ where: mocks.deleteWhere });
    mocks.updateWhere.mockResolvedValue(undefined);
    mocks.updateSet.mockReturnValue({ where: mocks.updateWhere });
    mocks.update.mockReturnValue({ set: mocks.updateSet });
  });

  it('rejects unsigned deletion before reading or mutating a reply', async () => {
    const response = await DELETE(deleteRequest() as never);

    expect(response.status).toBe(401);
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('rejects bad signatures and source-domain mismatches', async () => {
    const badSignature = await DELETE(deleteRequest({
      'X-Swarm-Source-Domain': 'source.social',
      'X-Swarm-Signature': 'bad',
    }) as never);
    expect(badSignature.status).toBe(403);

    const mismatch = await DELETE(deleteRequest({
      'X-Swarm-Source-Domain': 'other.social',
      'X-Swarm-Signature': 'signed',
    }) as never);
    expect(mismatch.status).toBe(400);
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it('deletes only the signed source namespace and resynchronizes its parent', async () => {
    mocks.verifySwarmRequest.mockResolvedValue(true);
    mocks.findFirst.mockResolvedValue({ id: 'stored-reply', replyToId: parentId });
    const response = await DELETE(deleteRequest({
      'X-Swarm-Source-Domain': 'source.social',
      'X-Swarm-Signature': 'signed',
    }) as never);

    expect(response.status).toBe(200);
    expect(mocks.verifySwarmRequest).toHaveBeenCalledWith(
      { replyId, nodeDomain: 'source.social', authorHandle: 'alice' },
      'signed',
      'source.social',
    );
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { apId: `swarm:source.social:${replyId}` },
    });
    expect(mocks.delete).toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalled();
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
});
