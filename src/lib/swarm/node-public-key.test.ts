import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { normalizeSwarmNodePublicKey } from './node-public-key';

const { publicKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

describe('node public key normalization', () => {
  it('treats harmless PEM whitespace as the same pinned identity', () => {
    expect(normalizeSwarmNodePublicKey(publicKey)).toBe(publicKey.trim());
    expect(normalizeSwarmNodePublicKey(`\n${publicKey}\n`)).toBe(publicKey.trim());
  });

  it('normalizes the equivalent DER representation to the same identity', () => {
    const der = crypto.createPublicKey(publicKey)
      .export({ type: 'spki', format: 'der' })
      .toString('base64');
    expect(normalizeSwarmNodePublicKey(der)).toBe(publicKey.trim());
  });

  it('rejects invalid and unsupported keys', () => {
    const rsa = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    expect(normalizeSwarmNodePublicKey('not a key')).toBeNull();
    expect(normalizeSwarmNodePublicKey(rsa.publicKey)).toBeNull();
  });
});
