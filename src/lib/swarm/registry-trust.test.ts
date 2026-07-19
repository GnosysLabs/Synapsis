import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: {
    query: {
      swarmNodes: { findFirst: mocks.findFirst },
    },
    update: mocks.update,
  },
  media: {},
  posts: {},
  swarmNodes: {},
  swarmSeeds: {},
  swarmSyncLog: {},
  users: {},
}));

import { getTrustedSwarmReadPeerPublicKey, markNodeSuccess } from './registry';

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
    mocks.update.mockReturnValue({ set: mocks.set });
    mocks.set.mockReturnValue({ where: mocks.where });
    mocks.where.mockResolvedValue(undefined);
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
    { publicKey: null },
  ])('rejects an unestablished, blocked, or unclassified peer: %o', async (override) => {
    mocks.findFirst.mockResolvedValue({ ...establishedPeer, ...override });

    await expect(getTrustedSwarmReadPeerPublicKey('peer.social'))
      .resolves.toBeNull();
  });

  it.each([
    { isActive: false },
    { trustScore: 25 },
    { trustScore: 0 },
  ])('allows a pinned peer to authenticate a bounded recovery read: %o', async (override) => {
    mocks.findFirst.mockResolvedValue({ ...establishedPeer, ...override });

    await expect(getTrustedSwarmReadPeerPublicKey('peer.social'))
      .resolves.toBe(peerPublicKey.trim());
  });

  it('restores availability trust after a verified content exchange', async () => {
    mocks.findFirst.mockResolvedValue({
      ...establishedPeer,
      trustScore: 0,
      lastSyncAt: new Date(),
      consecutiveFailures: 5,
    });

    await markNodeSuccess('peer.social', { verifiedContent: true });

    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({
      trustScore: 26,
      consecutiveFailures: 0,
      isActive: true,
    }));
  });
});
