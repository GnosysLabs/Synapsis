import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: {
    query: {
      swarmNodes: { findMany: mocks.findMany },
    },
  },
  media: {},
  posts: {},
  swarmNodes: {
    lastSeenAt: {},
  },
  swarmSeeds: {},
  swarmSyncLog: {},
  users: {},
}));

import { getSwarmDiscoveryCandidates } from './registry';

function node(domain: string, overrides: Record<string, unknown> = {}) {
  return {
    domain,
    name: domain,
    description: null,
    logoUrl: null,
    publicKey: null,
    softwareVersion: null,
    userCount: null,
    postCount: null,
    mediaCount: null,
    capabilities: null,
    isNsfw: false,
    nsfwClassificationKnown: true,
    lastSeenAt: new Date('2026-07-18T12:00:00.000Z'),
    trustScore: 75,
    ...overrides,
  };
}

describe('swarm discovery retries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retries inactive established peers even when they retain positive trust', async () => {
    mocks.findMany.mockResolvedValueOnce([
      node('rprh.link', { discoveredVia: 'direct' }),
    ]).mockResolvedValueOnce([
      node('new-node.social', {
        discoveredVia: 'synapsis.social',
        nsfwClassificationKnown: false,
        trustScore: 0,
      }),
    ]);

    await expect(getSwarmDiscoveryCandidates(2)).resolves.toEqual([
      expect.objectContaining({ domain: 'rprh.link', trustScore: 75 }),
      expect.objectContaining({ domain: 'new-node.social', trustScore: 0 }),
    ]);

    expect(mocks.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { AND: [
        { isActive: false },
        { isBlocked: false },
        { OR: [
          { discoveredVia: 'direct' },
          { discoveredVia: 'announcement' },
        ] },
      ] },
      limit: 2,
    }));
    expect(mocks.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { AND: expect.arrayContaining([{ trustScore: 0 }]) },
      limit: 1,
    }));
  });

  it('keeps discovery work bounded and gives established peers priority', async () => {
    mocks.findMany.mockResolvedValueOnce([
      node('rprh.link', { discoveredVia: 'direct' }),
      node('batorbros.bond', { discoveredVia: 'announcement' }),
    ]);

    const candidates = await getSwarmDiscoveryCandidates(100);

    expect(candidates.map((candidate) => candidate.domain)).toEqual([
      'rprh.link',
      'batorbros.bond',
    ]);
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }));
  });
});
