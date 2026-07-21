import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeFederationRequest: vi.fn(),
  getNodePrivateKey: vi.fn(),
  signPayload: vi.fn(),
  verifySignature: vi.fn(),
  getLocalNodePublicKey: vi.fn(),
  getTrustedPeerKey: vi.fn(),
  isNodeBlocked: vi.fn(),
  clearRemoteNodeAccessDenied: vi.fn(),
  markRemoteNodeAccessDenied: vi.fn(),
}));

vi.mock('./safe-federation-http', () => ({
  safeFederationRequest: mocks.safeFederationRequest,
}));

vi.mock('./signature', () => ({
  getNodePrivateKey: mocks.getNodePrivateKey,
  signPayload: mocks.signPayload,
  verifySignature: mocks.verifySignature,
}));

vi.mock('./node-keys', () => ({
  getNodePublicKey: mocks.getLocalNodePublicKey,
}));

vi.mock('./registry', () => ({
  getTrustedSwarmReadPeerPublicKey: mocks.getTrustedPeerKey,
}));

vi.mock('./node-blocklist', () => ({
  isNodeBlocked: mocks.isNodeBlocked,
}));

vi.mock('./remote-access', () => ({
  NODE_BLOCKED_CODE: 'NODE_BLOCKED',
  clearRemoteNodeAccessDenied: mocks.clearRemoteNodeAccessDenied,
  markRemoteNodeAccessDenied: mocks.markRemoteNodeAccessDenied,
  isRemoteNodeBlockResponse: (response: { status: number; json(): unknown }) =>
    response.status === 403
    && (response.json() as { code?: string }).code === 'NODE_BLOCKED',
}));

import { authorizeFederationRead, isTrustedFederationRead, signedFederationRead } from './signed-read';

function signedRequest({
  method = 'GET',
  nonce,
  timestamp = Date.now(),
}: {
  method?: string;
  nonce: string;
  timestamp?: number;
}) {
  return new Request('https://target.com/api/swarm/timeline?limit=5', {
    method,
    headers: {
      'X-Swarm-Read-Source': 'source.com',
      'X-Swarm-Read-Target': 'target.com',
      'X-Swarm-Read-Timestamp': String(timestamp),
      'X-Swarm-Read-Nonce': nonce,
      'X-Swarm-Read-Signature': 'peer-signature',
    },
  });
}

describe('signed federation reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'target.com');
    mocks.getNodePrivateKey.mockResolvedValue('LOCAL PRIVATE KEY');
    mocks.signPayload.mockReturnValue('local-signature');
    mocks.verifySignature.mockReturnValue(true);
    mocks.getTrustedPeerKey.mockResolvedValue('PINNED PEER PUBLIC KEY');
    mocks.isNodeBlocked.mockResolvedValue(false);
    mocks.safeFederationRequest.mockResolvedValue({
      status: 200,
      json: () => ({}),
    });
  });

  it('signs the exact GET path with a unique nonce', async () => {
    vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'source.com');

    await signedFederationRead('https://target.com/api/swarm/users/alice?limit=2');

    expect(mocks.signPayload).toHaveBeenCalledOnce();
    expect(mocks.signPayload.mock.calls[0][0]).toMatchObject({
      method: 'GET',
      path: '/api/swarm/users/alice?limit=2',
      sourceDomain: 'source.com',
      targetDomain: 'target.com',
      timestamp: expect.any(Number),
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/),
    });
    expect(mocks.safeFederationRequest).toHaveBeenCalledWith(
      'https://target.com/api/swarm/users/alice?limit=2',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'X-Swarm-Read-Source': 'source.com',
          'X-Swarm-Read-Target': 'target.com',
          'X-Swarm-Read-Nonce': expect.any(String),
          'X-Swarm-Read-Signature': 'local-signature',
        }),
      }),
    );
  });

  it('verifies against the registry-pinned key and rejects a replay', async () => {
    const request = signedRequest({ nonce: 'unique_nonce_value_000001' });

    await expect(isTrustedFederationRead(request)).resolves.toBe(true);
    expect(mocks.getTrustedPeerKey).toHaveBeenCalledWith('source.com');
    expect(mocks.verifySignature).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: '/api/swarm/timeline?limit=5',
        nonce: 'unique_nonce_value_000001',
      }),
      'peer-signature',
      'PINNED PEER PUBLIC KEY',
    );

    await expect(isTrustedFederationRead(request)).resolves.toBe(false);
  });

  it('rejects non-GET methods even when all signed headers are present', async () => {
    const request = signedRequest({
      method: 'POST',
      nonce: 'unique_nonce_value_000002',
    });

    await expect(isTrustedFederationRead(request)).resolves.toBe(false);
    expect(mocks.verifySignature).not.toHaveBeenCalled();
  });

  it('returns a distinct denial for a locally blocked signed peer', async () => {
    mocks.isNodeBlocked.mockResolvedValue(true);

    await expect(authorizeFederationRead(signedRequest({
      nonce: 'unique_nonce_value_blocked',
    }))).resolves.toEqual({
      ok: false,
      status: 403,
      code: 'NODE_BLOCKED',
      error: 'This node has blocked federation access from your origin',
    });
    expect(mocks.getTrustedPeerKey).not.toHaveBeenCalled();
    expect(mocks.verifySignature).not.toHaveBeenCalled();
  });

  it('records a remote block response so cached access can be quarantined', async () => {
    vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'source.com');
    mocks.safeFederationRequest.mockResolvedValue({
      status: 403,
      json: () => ({ code: 'NODE_BLOCKED' }),
    });

    await signedFederationRead('https://target.com/api/swarm/timeline');

    expect(mocks.markRemoteNodeAccessDenied).toHaveBeenCalledWith('target.com');
    expect(mocks.clearRemoteNodeAccessDenied).not.toHaveBeenCalled();
  });

  it('fails closed for stale signatures and peers without a pinned trusted key', async () => {
    await expect(isTrustedFederationRead(signedRequest({
      nonce: 'unique_nonce_value_000003',
      timestamp: Date.now() - 5 * 60 * 1000,
    }))).resolves.toBe(false);

    mocks.getTrustedPeerKey.mockResolvedValue(null);
    await expect(isTrustedFederationRead(signedRequest({
      nonce: 'unique_nonce_value_000004',
    }))).resolves.toBe(false);
    expect(mocks.verifySignature).not.toHaveBeenCalled();
  });
});
