import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  insert: vi.fn(),
  values: vi.fn(),
  update: vi.fn(),
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

import { upsertSwarmNode } from './registry';

describe('swarm registry authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insert.mockReturnValue({ values: mocks.values });
    mocks.values.mockResolvedValue(undefined);
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
      publicKey: 'PINNED KEY',
      isNsfw: false,
      nsfwClassificationKnown: true,
    });
    await expect(upsertSwarmNode({
      domain: 'peer.social',
      publicKey: 'CHANGED KEY',
      isNsfw: false,
    }, 'direct')).rejects.toThrow(/signing key changed/);
  });
});
