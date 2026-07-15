import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getNodePublicKey: vi.fn(),
}));

vi.mock('@/lib/swarm/node-keys', () => ({
  getNodePublicKey: mocks.getNodePublicKey,
}));

import { GET } from './route';

describe('GET /api/node/key', () => {
  beforeEach(() => {
    mocks.getNodePublicKey.mockReset();
    process.env.NEXT_PUBLIC_NODE_DOMAIN = 'node.example';
  });

  it('returns only the node identity needed for signature verification', async () => {
    mocks.getNodePublicKey.mockResolvedValue('public-key');

    const result = await GET();

    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    await expect(result.json()).resolves.toEqual({
      domain: 'node.example',
      publicKey: 'public-key',
    });
  });
});
