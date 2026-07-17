import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findPost: vi.fn(),
  findRemoteLike: vi.fn(),
  findUser: vi.fn(),
  findLike: vi.fn(),
  trustedRead: vi.fn(),
  requireClassification: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: {
    query: {
      posts: { findFirst: mocks.findPost },
      remoteLikes: { findFirst: mocks.findRemoteLike },
      users: { findFirst: mocks.findUser },
      likes: { findFirst: mocks.findLike },
    },
  },
}));
vi.mock('@/lib/swarm/signed-read', () => ({
  isTrustedFederationRead: mocks.trustedRead,
}));
vi.mock('@/lib/node/local-node', () => ({
  requireLocalNodeNsfwClassification: mocks.requireClassification,
}));

import { GET } from './route';

const postId = '15f11861-693a-4f70-8480-5d82bb8d14a7';
const context = { params: Promise.resolve({ id: postId }) };
const safeLocalPost = {
  id: postId,
  isRemoved: false,
  isNsfw: false,
  likesCount: 3,
  author: { handle: 'alice', nodeId: null, isNsfw: false },
};

describe('swarm like-state visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.trustedRead.mockResolvedValue(false);
    mocks.requireClassification.mockResolvedValue(false);
    mocks.findPost.mockResolvedValue(safeLocalPost);
  });

  it('denies unsigned metadata for a sensitive post', async () => {
    mocks.findPost.mockResolvedValue({ ...safeLocalPost, isNsfw: true });

    const response = await GET(new Request(
      `https://node.social/api/swarm/posts/${postId}/likes`,
    ) as never, context);

    expect(response.status).toBe(403);
  });

  it('denies caller-supplied like-state enumeration without a trusted signature', async () => {
    const response = await GET(new Request(
      `https://node.social/api/swarm/posts/${postId}/likes?checkHandle=alice`,
    ) as never, context);

    expect(response.status).toBe(403);
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it('allows an established signed peer to check remote like state', async () => {
    mocks.trustedRead.mockResolvedValue(true);
    mocks.findRemoteLike.mockResolvedValue({ id: 'like-id' });
    const response = await GET(new Request(
      `https://node.social/api/swarm/posts/${postId}/likes?checkHandle=alice&checkDomain=peer.social`,
    ) as never, context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      likesCount: 3,
      isLiked: true,
      checkedDomain: 'peer.social',
    });
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('fails closed for a cached remote author with a bare handle and node id', async () => {
    mocks.findPost.mockResolvedValue({
      ...safeLocalPost,
      author: { handle: 'legacy_remote', nodeId: 'remote-node-row', isNsfw: false },
    });
    const response = await GET(new Request(
      `https://node.social/api/swarm/posts/${postId}/likes`,
    ) as never, context);

    expect(response.status).toBe(403);
  });
});
