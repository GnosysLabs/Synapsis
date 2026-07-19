import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ signedFederationRead: vi.fn() }));

vi.mock('./signed-read', () => ({
  signedFederationRead: mocks.signedFederationRead,
}));

import { getViewerSwarmLikedPostIds } from './likes';

const target = {
  id: 'swarm:origin.social:11111111-1111-4111-8111-111111111111',
  nodeDomain: 'origin.social',
  originalPostId: '11111111-1111-4111-8111-111111111111',
};

describe('getViewerSwarmLikedPostIds', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts only an actual boolean true from the origin', async () => {
    mocks.signedFederationRead.mockResolvedValue({
      status: 200,
      json: () => ({ isLiked: true }),
    });

    await expect(getViewerSwarmLikedPostIds([target], 'alice', 'home.social'))
      .resolves.toEqual(new Set([target.id]));
  });

  it('rejects truthy attacker-controlled values', async () => {
    mocks.signedFederationRead.mockResolvedValue({
      status: 200,
      json: () => ({ isLiked: 'yes' }),
    });

    await expect(getViewerSwarmLikedPostIds([target], 'alice', 'home.social'))
      .resolves.toEqual(new Set());
  });
});
