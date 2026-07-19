import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeFederationRequest: vi.fn(),
  getPinnedSwarmNodePublicKey: vi.fn(),
  pinSwarmNodePublicKey: vi.fn(),
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
vi.mock('./registry', () => ({
  getPinnedSwarmNodePublicKey: mocks.getPinnedSwarmNodePublicKey,
  pinSwarmNodePublicKey: mocks.pinSwarmNodePublicKey,
}));

import crypto from 'node:crypto';
import { getNodePublicKey, signPayload, verifySwarmRequest } from './signature';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function response(status: number, body: unknown) {
  return { status, json: () => body };
}

describe('node public key discovery', () => {
  beforeEach(() => {
    mocks.safeFederationRequest.mockReset();
    mocks.getPinnedSwarmNodePublicKey.mockReset().mockResolvedValue(null);
    mocks.pinSwarmNodePublicKey.mockReset().mockResolvedValue(undefined);
  });

  it('uses a directly pinned key without following a remote key change', async () => {
    mocks.getPinnedSwarmNodePublicKey.mockResolvedValue(publicKey.trim());

    await expect(getNodePublicKey('pinned.example')).resolves.toBe(publicKey.trim());
    expect(mocks.safeFederationRequest).not.toHaveBeenCalled();
  });

  it('uses the bounded key-only endpoint', async () => {
    mocks.safeFederationRequest.mockResolvedValue(response(200, { publicKey }));

    await expect(getNodePublicKey('small.example')).resolves.toBe(publicKey.trim());
    expect(mocks.safeFederationRequest).toHaveBeenCalledOnce();
    expect(mocks.safeFederationRequest).toHaveBeenCalledWith(
      'https://small.example/api/node/key',
      expect.objectContaining({ maxResponseBytes: 16 * 1024 }),
    );
    expect(mocks.pinSwarmNodePublicKey).not.toHaveBeenCalled();
  });

  it('supports legacy nodes whose node document contains embedded branding', async () => {
    mocks.safeFederationRequest
      .mockResolvedValueOnce(response(404, {}))
      .mockResolvedValueOnce(response(200, { publicKey }));

    await expect(getNodePublicKey('legacy.example')).resolves.toBe(publicKey.trim());
    expect(mocks.safeFederationRequest).toHaveBeenNthCalledWith(
      2,
      'https://legacy.example/api/node',
      expect.objectContaining({ maxResponseBytes: 256 * 1024 }),
    );
  });

  it('pins first-contact keys only after a request proves possession', async () => {
    mocks.safeFederationRequest.mockResolvedValue(response(200, { publicKey }));
    const payload = { hello: 'world' };

    await expect(verifySwarmRequest(
      payload,
      signPayload(payload, privateKey),
      'verified.example',
    )).resolves.toBe(true);
    expect(mocks.pinSwarmNodePublicKey).toHaveBeenCalledWith('verified.example', publicKey.trim());
  });

  it('rejects unsupported key algorithms without persisting them', async () => {
    const rsa = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    mocks.safeFederationRequest.mockResolvedValue(response(200, { publicKey: rsa.publicKey }));

    await expect(getNodePublicKey('rsa.example')).resolves.toBeNull();
    expect(mocks.pinSwarmNodePublicKey).not.toHaveBeenCalled();
  });
});
