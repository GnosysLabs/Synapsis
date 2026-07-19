import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findPost: vi.fn(),
  findRemoteLike: vi.fn(),
  trustedReadSource: vi.fn(),
  requireClassification: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: {
    query: {
      posts: { findFirst: mocks.findPost },
      remoteLikes: { findFirst: mocks.findRemoteLike },
    },
  },
}));
vi.mock('@/lib/swarm/signed-read', () => ({
  getTrustedFederationReadSource: mocks.trustedReadSource,
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
    mocks.trustedReadSource.mockResolvedValue(null);
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
    expect(mocks.findRemoteLike).not.toHaveBeenCalled();
  });

  it('allows an established signed peer to check remote like state', async () => {
    mocks.trustedReadSource.mockResolvedValue('peer.social');
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

  it('does not let one signed peer enumerate another node\'s actors', async () => {
    mocks.trustedReadSource.mockResolvedValue('evil.social');

    const response = await GET(new Request(
      `https://node.social/api/swarm/posts/${postId}/likes?checkHandle=alice&checkDomain=peer.social`,
    ) as never, context);

    expect(response.status).toBe(403);
    expect(mocks.findRemoteLike).not.toHaveBeenCalled();
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
