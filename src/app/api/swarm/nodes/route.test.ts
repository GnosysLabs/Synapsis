import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getActiveSwarmNodes: vi.fn(),
  getSwarmStats: vi.fn(),
}));

vi.mock('@/lib/swarm/registry', () => ({
  getActiveSwarmNodes: mocks.getActiveSwarmNodes,
  getSwarmStats: mocks.getSwarmStats,
  addSeedNode: vi.fn(),
}));
vi.mock('@/lib/swarm/discovery', () => ({
  announceToSeeds: vi.fn(),
  announceToNode: vi.fn(),
  discoverNode: vi.fn(),
}));
vi.mock('@/lib/swarm/gossip', () => ({
  runGossipRound: vi.fn(),
  gossipToNode: vi.fn(),
}));

import { GET } from './route';

describe('public swarm node directory', () => {
  it('does not expose local reputation signals', async () => {
    mocks.getActiveSwarmNodes.mockResolvedValue([{
      domain: 'peer.social',
      trustScore: 37,
      isNsfw: false,
    }]);

    const response = await GET(new Request('https://local.social/api/swarm/nodes'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.nodes).toEqual([{ domain: 'peer.social', isNsfw: false }]);
  });
});
