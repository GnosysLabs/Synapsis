import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findRemoteFollows: vi.fn(),
  isSwarmNode: vi.fn(),
  cacheSwarmUserPosts: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: {
    query: {
      remoteFollows: { findMany: mocks.findRemoteFollows },
    },
  },
}));

vi.mock('@/lib/swarm/interactions', () => ({
  isSwarmNode: mocks.isSwarmNode,
  cacheSwarmUserPosts: mocks.cacheSwarmUserPosts,
}));

import { clearSyncCache, syncRemoteFollowsPosts } from './remote-sync';

function follows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    targetHandle: `user${index}@node${index}.social`,
  }));
}

describe('remote follows sync containment', () => {
  beforeEach(() => {
    clearSyncCache();
    mocks.findRemoteFollows.mockReset();
    mocks.isSwarmNode.mockReset().mockResolvedValue(true);
    mocks.cacheSwarmUserPosts.mockReset().mockResolvedValue({ cached: 1, skipped: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shares one in-flight run between overlapping scheduler calls', async () => {
    let finishFetch: ((value: { cached: number; skipped: number }) => void) | undefined;
    mocks.findRemoteFollows.mockResolvedValue(follows(1));
    mocks.cacheSwarmUserPosts.mockImplementation(() => new Promise((resolve) => {
      finishFetch = resolve;
    }));

    const first = syncRemoteFollowsPosts('https://local.social');
    const second = syncRemoteFollowsPosts('https://local.social');

    expect(second).toBe(first);
    await vi.waitFor(() => expect(mocks.cacheSwarmUserPosts).toHaveBeenCalledTimes(1));
    finishFetch?.({ cached: 1, skipped: 0 });
    await first;
    expect(mocks.findRemoteFollows).toHaveBeenCalledTimes(1);
  });

  it('caps each run at twenty targets without starving the remainder', async () => {
    const rows = follows(25);
    mocks.findRemoteFollows.mockImplementation(({ offset = 0, limit = rows.length }) => (
      rows.slice(offset, offset + limit)
    ));

    const first = await syncRemoteFollowsPosts('https://local.social');
    const second = await syncRemoteFollowsPosts('https://local.social');

    expect(first.synced).toBe(20);
    expect(second.synced).toBe(5);
    expect(mocks.cacheSwarmUserPosts).toHaveBeenCalledTimes(25);
  });

  it('stops starting targets after the run deadline', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    mocks.findRemoteFollows.mockResolvedValue(follows(3));
    mocks.isSwarmNode.mockImplementation(async () => {
      now += 46_000;
      return true;
    });

    const result = await syncRemoteFollowsPosts('https://local.social');

    expect(mocks.cacheSwarmUserPosts).toHaveBeenCalledTimes(1);
    expect(result.skipped).toBe(2);
  });

  it('backs off an unavailable or empty remote instead of retrying every minute', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    mocks.findRemoteFollows.mockResolvedValue(follows(1));
    mocks.cacheSwarmUserPosts.mockResolvedValue({ cached: 0, skipped: 0 });

    await syncRemoteFollowsPosts('https://local.social');
    now += 60 * 1_000;
    await syncRemoteFollowsPosts('https://local.social');

    expect(mocks.cacheSwarmUserPosts).toHaveBeenCalledTimes(1);

    now += 5 * 60 * 1_000;
    await syncRemoteFollowsPosts('https://local.social');
    expect(mocks.cacheSwarmUserPosts).toHaveBeenCalledTimes(2);
  });
});
