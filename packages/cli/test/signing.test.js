import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { canonicalize, generateCredentialKeyPair, signAction } from '../src/signing.js';

test('signs the canonical CLI envelope with a raw P-256 signature', async () => {
  const keys = await generateCredentialKeyPair();
  const profile = { credentialId: 'credential-1', privateKey: keys.privateKey };
  const signed = await signAction(profile, 'post', { content: 'Hello', mediaIds: [] }, {
    nonce: 'fixed-nonce',
    ts: 1_700_000_000_000,
  });
  const { sig, ...payload } = signed;
  const publicKey = await webcrypto.subtle.importKey(
    'spki',
    Buffer.from(keys.publicKey, 'base64'),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const valid = await webcrypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    Buffer.from(sig, 'base64url'),
    new TextEncoder().encode(canonicalize(payload)),
  );
  assert.equal(valid, true);
  assert.equal(Buffer.from(sig, 'base64url').length, 64);
});

test('canonicalization sorts object keys and preserves array order', () => {
  assert.equal(canonicalize({ z: 1, a: ['b', 'a'] }), '{"a":["b","a"],"z":1}');
});
