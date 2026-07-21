import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorizeFederationRead: vi.fn(),
  getCachedVerifiedChangeBundle: vi.fn(),
  isRateLimited: vi.fn(() => false),
}));

vi.mock('@/lib/swarm/signed-read', () => ({
  authorizeFederationRead: mocks.authorizeFederationRead,
  federationReadFailureResponse: (authorization: { status: number; code: string; error: string }) =>
    Response.json({ error: authorization.error, code: authorization.code }, { status: authorization.status }),
}));

vi.mock('@/lib/swarm/change-bundle', () => ({
  getCachedVerifiedChangeBundle: mocks.getCachedVerifiedChangeBundle,
}));

vi.mock('@/lib/rate-limit', () => ({
  isRateLimited: mocks.isRateLimited,
}));

import { GET } from './route';

describe('GET /api/swarm/change-bundles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isRateLimited.mockReturnValue(false);
  });

  it('does not expose cached bundles to unauthenticated callers', async () => {
    mocks.authorizeFederationRead.mockResolvedValue({
      ok: false,
      status: 401,
      code: 'FEDERATION_AUTH_REQUIRED',
      error: 'Authenticated federation read required',
    });
    const response = await GET(new Request(
      'https://relay.social/api/swarm/change-bundles?origin=origin.social&after=10',
    ));
    expect(response.status).toBe(401);
    expect(mocks.getCachedVerifiedChangeBundle).not.toHaveBeenCalled();
  });

  it('serves the unchanged origin-signed object to an authenticated peer', async () => {
    mocks.authorizeFederationRead.mockResolvedValue({ ok: true, sourceDomain: 'receiver.social' });
    const signed = {
      bundle: { type: 'ChangeBundle', version: 1, origin: 'origin.social' },
      signature: 'origin-signature',
    };
    mocks.getCachedVerifiedChangeBundle.mockResolvedValue({ signed });
    const response = await GET(new Request(
      'https://relay.social/api/swarm/change-bundles?origin=origin.social&after=10',
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(signed);
    expect(mocks.getCachedVerifiedChangeBundle).toHaveBeenCalledWith('origin.social', 10);
  });
});
