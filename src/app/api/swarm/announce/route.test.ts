import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifySwarmRequestDetailed: vi.fn(),
  upsertSwarmNode: vi.fn(),
  markNodeSuccess: vi.fn(),
  buildAnnouncement: vi.fn(),
}));

vi.mock('@/lib/swarm/signature', () => ({
  isFreshFederationTimestamp: vi.fn().mockReturnValue(true),
  verifySwarmRequestDetailed: mocks.verifySwarmRequestDetailed,
}));

vi.mock('@/lib/swarm/registry', () => ({
  upsertSwarmNode: mocks.upsertSwarmNode,
  markNodeSuccess: mocks.markNodeSuccess,
}));

vi.mock('@/lib/swarm/discovery', () => ({
  buildAnnouncement: mocks.buildAnnouncement,
}));

vi.mock('@/lib/rate-limit', () => ({
  isRateLimited: vi.fn().mockReturnValue(false),
}));

import { POST } from './route';

describe('POST /api/swarm/announce optional branding compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'receiver.social');
    mocks.verifySwarmRequestDetailed.mockResolvedValue({ ok: true, domain: 'peer.social' });
    mocks.upsertSwarmNode.mockResolvedValue({ isNew: false });
    mocks.buildAnnouncement.mockResolvedValue({
      domain: 'receiver.social',
      name: 'Receiver',
      publicKey: 'RECEIVER KEY',
      softwareVersion: '1',
      userCount: 1,
      postCount: 1,
      mediaCount: 0,
      contentSequence: 1,
      isNsfw: false,
      capabilities: ['gossip'],
    });
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('verifies the original signed logo URL but omits it from stored metadata', async () => {
    const legacyLogoUrl = 'https://peer.social/api/node/logo?v=1';
    const body = {
      domain: 'peer.social',
      name: 'Peer',
      logoUrl: legacyLogoUrl,
      publicKey: 'PEER KEY',
      softwareVersion: '1',
      userCount: 1,
      postCount: 1,
      mediaCount: 0,
      contentSequence: 1,
      isNsfw: false,
      capabilities: ['gossip'],
      timestamp: new Date().toISOString(),
      signature: 'signature',
    };

    const response = await POST(new Request('https://receiver.social/api/swarm/announce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));

    expect(response.status).toBe(200);
    expect(mocks.verifySwarmRequestDetailed).toHaveBeenCalledWith(
      expect.objectContaining({ logoUrl: legacyLogoUrl }),
      'signature',
      'peer.social',
    );
    expect(mocks.upsertSwarmNode).toHaveBeenCalledWith(
      expect.objectContaining({ logoUrl: undefined }),
      'announcement',
    );
    expect(mocks.markNodeSuccess).toHaveBeenCalledWith(
      'peer.social',
      { verifiedExchange: true },
    );
  });
});
