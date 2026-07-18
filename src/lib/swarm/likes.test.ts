import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  from: vi.fn(),
  where: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: { select: mocks.select },
  userSwarmLikes: {
    userId: 'user_id',
    nodeDomain: 'node_domain',
    originalPostId: 'original_post_id',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...values) => values),
  eq: vi.fn((...values) => values),
  inArray: vi.fn((...values) => values),
}));

import { getViewerSwarmLikedPostIds } from './likes';

const target = {
  id: 'swarm:origin.social:11111111-1111-4111-8111-111111111111',
  nodeDomain: 'origin.social',
  originalPostId: '11111111-1111-4111-8111-111111111111',
};

describe('getViewerSwarmLikedPostIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.select.mockReturnValue({ from: mocks.from });
    mocks.from.mockReturnValue({ where: mocks.where });
    mocks.where.mockResolvedValue([]);
  });

  it('maps only rows in the local durable interaction ledger', async () => {
    mocks.where.mockResolvedValue([{
      nodeDomain: target.nodeDomain,
      originalPostId: target.originalPostId,
    }]);

    await expect(getViewerSwarmLikedPostIds([target], 'viewer-id'))
      .resolves.toEqual(new Set([target.id]));
  });

  it('does not infer a like when the ledger has no matching row', async () => {
    await expect(getViewerSwarmLikedPostIds([target], 'viewer-id'))
      .resolves.toEqual(new Set());
  });
});
