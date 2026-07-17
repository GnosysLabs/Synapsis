import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: {
    query: {
      swarmNodes: { findFirst: mocks.findFirst },
    },
  },
  media: {},
  posts: {},
  swarmNodes: {},
  swarmSeeds: {},
  swarmSyncLog: {},
  users: {},
}));

import { getTrustedSwarmReadPeerPublicKey } from './registry';

const establishedPeer = {
  domain: 'peer.social',
  discoveredVia: 'direct',
  isActive: true,
  isBlocked: false,
  nsfwClassificationKnown: true,
  trustScore: 50,
  publicKey: 'PINNED PUBLIC KEY',
};

describe('trusted swarm read peers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the pinned key for a directly established, classified peer', async () => {
    mocks.findFirst.mockResolvedValue(establishedPeer);

    await expect(getTrustedSwarmReadPeerPublicKey('peer.social'))
      .resolves.toBe('PINNED PUBLIC KEY');
  });

  it.each([
    { discoveredVia: 'gossip' },
    { nsfwClassificationKnown: false },
    { trustScore: 49 },
    { isBlocked: true },
    { isActive: false },
    { publicKey: null },
  ])('rejects an unestablished or unhealthy peer: %o', async (override) => {
    mocks.findFirst.mockResolvedValue({ ...establishedPeer, ...override });

    await expect(getTrustedSwarmReadPeerPublicKey('peer.social'))
      .resolves.toBeNull();
  });
});
