import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  update: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
  delete: vi.fn(),
  deleteWhere: vi.fn(),
}));

const tables = vi.hoisted(() => ({
  remotePosts: { nodeDomain: 'remotePosts.nodeDomain' },
  remoteFeedStories: { nodeDomain: 'remoteFeedStories.nodeDomain' },
  swarmNodes: {
    domain: 'swarmNodes.domain',
    remoteAccessDeniedAt: 'swarmNodes.remoteAccessDeniedAt',
  },
  userSwarmLikes: { nodeDomain: 'userSwarmLikes.nodeDomain' },
  userSwarmReposts: { nodeDomain: 'userSwarmReposts.nodeDomain' },
}));

vi.mock('@/db', () => ({
  db: {
    transaction: mocks.transaction,
    update: mocks.update,
  },
  ...tables,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
}));

import { markRemoteNodeAccessDenied } from './remote-access';

describe('remote federation access quarantine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateSet.mockReturnValue({ where: mocks.updateWhere });
    mocks.update.mockReturnValue({ set: mocks.updateSet });
    mocks.delete.mockReturnValue({ where: mocks.deleteWhere });
    mocks.transaction.mockImplementation(async (callback) => callback({
      update: mocks.update,
      delete: mocks.delete,
    }));
  });

  it('purges ordinary caches and scrubs retained repost snapshots', async () => {
    await markRemoteNodeAccessDenied('RPRH.EXAMPLE', 'Remote block');

    expect(mocks.delete).toHaveBeenCalledWith(tables.remotePosts);
    expect(mocks.delete).toHaveBeenCalledWith(tables.remoteFeedStories);
    expect(mocks.delete).toHaveBeenCalledWith(tables.userSwarmLikes);
    expect(mocks.updateSet).toHaveBeenCalledWith(expect.objectContaining({
      content: '',
      authorDisplayName: null,
      authorAvatarUrl: null,
      mediaJson: null,
      linkPreviewUrl: null,
      originUnavailableAt: expect.any(Date),
    }));
    expect(mocks.updateSet).toHaveBeenCalledWith(expect.objectContaining({
      remoteAccessDeniedAt: expect.any(Date),
      remoteAccessDeniedReason: 'Remote block',
    }));
  });
});
