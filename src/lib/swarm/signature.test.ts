import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeFederationRequest: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: {
    query: { users: { findFirst: vi.fn() } },
  },
  users: {},
}));

vi.mock('./node-blocklist', () => ({
  isNodeBlocked: vi.fn().mockResolvedValue(false),
  normalizeNodeDomain: (domain: string) => domain.toLowerCase(),
}));

vi.mock('./node-domain', () => ({
  getPublicSwarmDomain: (domain: string) => domain,
}));

vi.mock('./safe-federation-http', () => ({
  safeFederationRequest: mocks.safeFederationRequest,
}));

import { getNodePublicKey } from './signature';

function response(status: number, body: unknown) {
  return { status, json: () => body };
}

describe('node public key discovery', () => {
  beforeEach(() => {
    mocks.safeFederationRequest.mockReset();
  });

  it('uses the bounded key-only endpoint', async () => {
    mocks.safeFederationRequest.mockResolvedValue(response(200, { publicKey: 'node-key' }));

    await expect(getNodePublicKey('small.example')).resolves.toBe('node-key');
    expect(mocks.safeFederationRequest).toHaveBeenCalledOnce();
    expect(mocks.safeFederationRequest).toHaveBeenCalledWith(
      'https://small.example/api/node/key',
      expect.objectContaining({ maxResponseBytes: 16 * 1024 }),
    );
  });

  it('supports legacy nodes whose node document contains embedded branding', async () => {
    mocks.safeFederationRequest
      .mockResolvedValueOnce(response(404, {}))
      .mockResolvedValueOnce(response(200, { publicKey: 'legacy-node-key' }));

    await expect(getNodePublicKey('legacy.example')).resolves.toBe('legacy-node-key');
    expect(mocks.safeFederationRequest).toHaveBeenNthCalledWith(
      2,
      'https://legacy.example/api/node',
      expect.objectContaining({ maxResponseBytes: 256 * 1024 }),
    );
  });
});
