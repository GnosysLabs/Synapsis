import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  insert: vi.fn(),
  values: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: {
    query: { swarmNodes: { findFirst: mocks.findFirst } },
    insert: mocks.insert,
    update: mocks.update,
  },
  media: {},
  posts: {},
  swarmNodes: {},
  swarmSeeds: {},
  swarmSyncLog: {},
  users: {},
}));

import { pinSwarmNodePublicKey, upsertSwarmNode } from './registry';

const firstIdentity = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
}).publicKey;
const changedIdentity = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
}).publicKey;

describe('swarm registry authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insert.mockReturnValue({ values: mocks.values });
    mocks.values.mockResolvedValue(undefined);
    mocks.update.mockReturnValue({ set: mocks.set });
    mocks.set.mockReturnValue({ where: mocks.where });
    mocks.where.mockResolvedValue(undefined);
  });

  it('stores relayed nodes only as inactive discovery hints', async () => {
    mocks.findFirst.mockResolvedValue(null);
    await upsertSwarmNode({
      domain: 'relayed.social',
      name: 'Attacker supplied name',
      publicKey: 'ATTACKER KEY',
      isNsfw: false,
    }, 'gossip-source.social');

    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'relayed.social',
      isActive: false,
      trustScore: 0,
      publicKey: undefined,
      name: undefined,
      nsfwClassificationKnown: false,
    }));
  });

  it('does not let relayed gossip overwrite an established node', async () => {
    mocks.findFirst.mockResolvedValue({
      domain: 'peer.social',
      discoveredVia: 'direct',
      publicKey: 'PINNED KEY',
    });
    await upsertSwarmNode({
      domain: 'peer.social',
      name: 'Poisoned',
      publicKey: 'ATTACKER KEY',
      isNsfw: false,
    }, 'relay.social');
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('rejects incomplete direct identities and pinned key changes', async () => {
    mocks.findFirst.mockResolvedValue(null);
    await expect(upsertSwarmNode({
      domain: 'peer.social',
      isNsfw: false,
    }, 'direct')).rejects.toThrow(/identity is incomplete/);

    mocks.findFirst.mockResolvedValue({
      domain: 'peer.social',
      discoveredVia: 'direct',
      publicKey: firstIdentity,
      isNsfw: false,
      nsfwClassificationKnown: true,
    });
    await expect(upsertSwarmNode({
      domain: 'peer.social',
      publicKey: changedIdentity,
      isNsfw: false,
    }, 'direct')).rejects.toThrow(/signing key changed/);
  });

  it('accepts the same pinned key across harmless PEM whitespace changes', async () => {
    mocks.findFirst.mockResolvedValue({
      domain: 'peer.social',
      discoveredVia: 'direct',
      publicKey: firstIdentity,
      isNsfw: false,
      nsfwClassificationKnown: true,
      isBlocked: false,
      name: 'Peer',
    });

    await expect(upsertSwarmNode({
      domain: 'peer.social',
      publicKey: firstIdentity.trim(),
      isNsfw: false,
    }, 'direct')).resolves.toEqual({ isNew: false });
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({
      publicKey: firstIdentity.trim(),
      isActive: true,
      consecutiveFailures: 0,
    }));
  });

  it('pins the same legacy PEM identity without treating its trailing newline as rotation', async () => {
    mocks.findFirst.mockResolvedValue({
      domain: 'peer.social',
      discoveredVia: 'direct',
      publicKey: firstIdentity,
    });

    await expect(pinSwarmNodePublicKey('peer.social', firstIdentity.trim())).resolves.toBeUndefined();
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({
      publicKey: firstIdentity.trim(),
    }));
  });
});
