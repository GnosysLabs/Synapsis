import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  runGossipRound: vi.fn(),
  announceToSeeds: vi.fn(),
  getSwarmStats: vi.fn(),
}));

vi.mock('@/lib/swarm/gossip', () => ({ runGossipRound: mocks.runGossipRound }));
vi.mock('@/lib/swarm/discovery', () => ({ announceToSeeds: mocks.announceToSeeds }));
vi.mock('@/lib/swarm/registry', () => ({ getSwarmStats: mocks.getSwarmStats }));

import { POST } from './route';

const originalAuthSecret = process.env.AUTH_SECRET;

function request(authorization?: string) {
  return new NextRequest('https://local.example/api/cron/swarm', {
    method: 'POST',
    headers: authorization ? { authorization } : undefined,
  });
}

describe('POST /api/cron/swarm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AUTH_SECRET;
    mocks.runGossipRound.mockResolvedValue({ contacted: 0 });
    mocks.getSwarmStats.mockResolvedValue({ activeNodes: 0 });
  });

  afterAll(() => {
    if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = originalAuthSecret;
  });

  it('fails closed when AUTH_SECRET is missing', async () => {
    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(mocks.runGossipRound).not.toHaveBeenCalled();
    expect(mocks.announceToSeeds).not.toHaveBeenCalled();
    expect(mocks.getSwarmStats).not.toHaveBeenCalled();
  });

  it('still runs with the exact configured bearer secret', async () => {
    process.env.AUTH_SECRET = 'cron-test-secret';

    const response = await POST(request('Bearer cron-test-secret'));

    expect(response.status).toBe(200);
    expect(mocks.runGossipRound).toHaveBeenCalledOnce();
    expect(mocks.getSwarmStats).toHaveBeenCalledOnce();
  });
});
