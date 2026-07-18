import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  signedFederationRead: vi.fn(),
}));

vi.mock('./signed-read', () => ({
  signedFederationRead: mocks.signedFederationRead,
}));

import { refreshFederatedReplyCounts } from './reply-counts';

const remotePostId = '11111111-1111-4111-8111-111111111111';

describe('refreshFederatedReplyCounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replaces a stale repost snapshot count with the live origin thread count', async () => {
    mocks.signedFederationRead.mockResolvedValue({
      status: 200,
      json: () => ({ replies: [{ id: 'reply-1' }] }),
    });

    const [post] = await refreshFederatedReplyCounts([{
      id: `swarm:origin.social:${remotePostId}`,
      repliesCount: 0,
      content: 'Remote post',
    }]);

    expect(post.repliesCount).toBe(1);
    expect(post.content).toBe('Remote post');
    expect(mocks.signedFederationRead).toHaveBeenCalledWith(
      `https://origin.social/api/swarm/replies?postId=${remotePostId}`,
      expect.any(Object),
    );
  });

  it('allows a live deletion to reduce a stale snapshot count', async () => {
    mocks.signedFederationRead.mockResolvedValue({
      status: 200,
      json: () => ({ replies: [] }),
    });

    const [post] = await refreshFederatedReplyCounts([{
      id: `swarm:origin.social:${remotePostId}`,
      repliesCount: 3,
    }]);

    expect(post.repliesCount).toBe(0);
  });

  it('keeps the cached count when the origin cannot be reached', async () => {
    mocks.signedFederationRead.mockRejectedValue(new Error('offline'));

    const [post] = await refreshFederatedReplyCounts([{
      id: `swarm:origin.social:${remotePostId}`,
      repliesCount: 2,
    }]);

    expect(post.repliesCount).toBe(2);
  });

  it('keeps the cached count when a hostile node returns an oversized reply list', async () => {
    mocks.signedFederationRead.mockResolvedValue({
      status: 200,
      json: () => ({ replies: Array.from({ length: 51 }, (_, id) => ({ id })) }),
    });

    const [post] = await refreshFederatedReplyCounts([{
      id: `swarm:origin.social:${remotePostId}`,
      repliesCount: 7,
    }]);

    expect(post.repliesCount).toBe(7);
  });

  it('does not make federation requests for local posts', async () => {
    const posts = [{ id: remotePostId, repliesCount: 4 }];

    await expect(refreshFederatedReplyCounts(posts)).resolves.toEqual(posts);
    expect(mocks.signedFederationRead).not.toHaveBeenCalled();
  });
});
