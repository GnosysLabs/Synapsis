import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeFederationRequest: vi.fn(),
  upsertSwarmNode: vi.fn(),
  markNodeSuccess: vi.fn(),
  markNodeFailure: vi.fn(),
  signPayload: vi.fn().mockReturnValue('signature'),
}));

vi.mock('@/db', () => ({
  db: null,
  users: {},
  posts: {},
  media: {},
}));

vi.mock('@/lib/version', () => ({
  getCurrentBuildInfo: () => ({ commitCount: 2, version: '0.1.0' }),
}));

vi.mock('@/lib/node/local-node', () => ({
  requireLocalNodeNsfwClassification: vi.fn().mockResolvedValue(false),
}));

vi.mock('./registry', () => ({
  upsertSwarmNode: mocks.upsertSwarmNode,
  getSeedNodes: vi.fn().mockResolvedValue([]),
  markNodeSuccess: mocks.markNodeSuccess,
  markNodeFailure: mocks.markNodeFailure,
}));

vi.mock('./safe-federation-http', () => ({
  safeFederationRequest: mocks.safeFederationRequest,
}));

vi.mock('./signature', () => ({
  getNodePrivateKey: vi.fn().mockResolvedValue('PRIVATE KEY'),
  signPayload: mocks.signPayload,
}));

import { announceToNode } from './discovery';

describe('mixed-version swarm announcements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'local.social');
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('re-signs a legacy announcement after an older strict peer returns 400', async () => {
    mocks.safeFederationRequest
      .mockResolvedValueOnce({ status: 400 })
      .mockResolvedValueOnce({
        status: 200,
        json: () => ({
          domain: 'peer.social',
          publicKey: 'PEER KEY',
          isNsfw: false,
        }),
      });

    await expect(announceToNode('peer.social')).resolves.toEqual({ success: true });

    expect(mocks.safeFederationRequest).toHaveBeenCalledTimes(2);
    const firstOptions = mocks.safeFederationRequest.mock.calls[0]?.[1] as { body: string };
    const secondOptions = mocks.safeFederationRequest.mock.calls[1]?.[1] as { body: string };
    const firstPayload = JSON.parse(firstOptions.body) as Record<string, unknown>;
    const secondPayload = JSON.parse(secondOptions.body) as Record<string, unknown>;

    expect(firstPayload).toMatchObject({ contentSequence: 0, signature: 'signature' });
    expect(secondPayload).not.toHaveProperty('contentSequence');
    expect(secondPayload).toHaveProperty('signature', 'signature');
    expect(mocks.signPayload).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({ contentSequence: expect.anything() }),
      'PRIVATE KEY',
    );
    expect(mocks.upsertSwarmNode).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'peer.social' }),
      'direct',
    );
    expect(mocks.markNodeSuccess).toHaveBeenCalledWith('peer.social');
    expect(mocks.markNodeFailure).not.toHaveBeenCalled();
  });
});
