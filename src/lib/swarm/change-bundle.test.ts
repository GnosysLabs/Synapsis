import crypto from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTrustedSwarmReadPeerPublicKey: vi.fn(),
}));

vi.mock('./registry', () => ({
  getTrustedSwarmReadPeerPublicKey: mocks.getTrustedSwarmReadPeerPublicKey,
}));

import {
  CHANGE_BUNDLE_LIFETIME_MS,
  changeBundleV1Schema,
  validateChangeBundleTiming,
  verifySignedChangeBundle,
  type ChangeBundleV1,
} from './change-bundle';
import { signPayload } from './signature';

let privateKey: string;

function bundleAt(now: number): ChangeBundleV1 {
  return {
    type: 'ChangeBundle',
    version: 1,
    origin: 'origin.social',
    fromCursor: 10,
    toCursor: 12,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CHANGE_BUNDLE_LIFETIME_MS).toISOString(),
    changes: [{
      sequence: 12,
      type: 'delete',
      postId: 'deleted-post',
      changedAt: new Date(now).toISOString(),
    }],
    hasMoreChanges: false,
    nodeIsNsfw: false,
  };
}

beforeAll(() => {
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  mocks.getTrustedSwarmReadPeerPublicKey.mockResolvedValue(
    keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  );
});

describe('ChangeBundleV1 origin authority', () => {
  it('accepts an intact origin-signed page and rejects relay modification', async () => {
    const bundle = changeBundleV1Schema.parse(bundleAt(Date.now()));
    const signature = signPayload(bundle, privateKey);
    await expect(verifySignedChangeBundle({ bundle, signature }, bundle.origin))
      .resolves.toMatchObject({ fromCursor: 10, toCursor: 12 });
    await expect(verifySignedChangeBundle({
      bundle: { ...bundle, nodeIsNsfw: true },
      signature,
    }, bundle.origin)).rejects.toThrow('origin signature');
  });

  it('rejects cursor gaps, unknown fields, and expired pages', async () => {
    const current = bundleAt(Date.now());
    const invalidRange = { ...current, fromCursor: 12 };
    await expect(verifySignedChangeBundle({
      bundle: invalidRange,
      signature: signPayload(invalidRange, privateKey),
    }, current.origin)).rejects.toThrow('sequence');
    expect(() => changeBundleV1Schema.parse({ ...current, relayAuthority: true })).toThrow();

    const old = bundleAt(Date.now() - CHANGE_BUNDLE_LIFETIME_MS - 60_000);
    expect(validateChangeBundleTiming(old)).toBe('expired');
  });
});
