import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

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

const peerPublicKey = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
}).publicKey;

const establishedPeer = {
  domain: 'peer.social',
  discoveredVia: 'direct',
  isActive: true,
  isBlocked: false,
  nsfwClassificationKnown: true,
  trustScore: 50,
  publicKey: peerPublicKey,
};

describe('trusted swarm read peers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the pinned key for a directly established, classified peer', async () => {
    mocks.findFirst.mockResolvedValue(establishedPeer);

    await expect(getTrustedSwarmReadPeerPublicKey('peer.social'))
      .resolves.toBe(peerPublicKey.trim());
  });

  it.each([
    { discoveredVia: 'gossip' },
    { nsfwClassificationKnown: false },
    { discoveredVia: 'key' },
    { isBlocked: true },
    { isActive: false },
    { trustScore: 25 },
    { publicKey: null },
  ])('rejects an unestablished or unhealthy peer: %o', async (override) => {
    mocks.findFirst.mockResolvedValue({ ...establishedPeer, ...override });

    await expect(getTrustedSwarmReadPeerPublicKey('peer.social'))
      .resolves.toBeNull();
  });
});
