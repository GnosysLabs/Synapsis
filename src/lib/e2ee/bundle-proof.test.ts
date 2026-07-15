import { base58btc } from 'multiformats/bases/base58';
import { afterEach, describe, expect, it } from 'vitest';

import { generateDID } from '@/lib/auth';
import { generateKeyPair as generatePemKeyPair } from '@/lib/crypto/keys';
import {
  didKeyMatchesPublicKey,
  normalizeSigningPublicKey,
  signingPublicKeyFromDid,
} from '@/lib/crypto/did-key';
import {
  clearUserPrivateKey,
  createSignedAction,
  importPrivateKey,
  keyStore,
} from '@/lib/crypto/user-signing';
import { verifyE2EEPublicBundle } from './bundle-proof';
import { generateE2EEKeyMaterial } from './client-crypto';
import { E2EE_PROTOCOL, type E2EEKeyBundle } from './protocol';

function pemBody(pem: string): Uint8Array {
  return Uint8Array.from(Buffer.from(
    pem
      .replace(/-----BEGIN PRIVATE KEY-----/g, '')
      .replace(/-----END PRIVATE KEY-----/g, '')
      .replace(/\s/g, ''),
    'base64',
  ));
}

function bundle(
  material: Awaited<ReturnType<typeof generateE2EEKeyMaterial>>,
): E2EEKeyBundle {
  return {
    protocol: E2EE_PROTOCOL,
    keyId: material.keyId,
    version: 1,
    publicKey: material.publicKey,
    createdAt: Date.now(),
    recoveryCommitment: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  };
}

async function signedBundleResponse(did: string) {
  const signingKeys = await generatePemKeyPair();
  const signingPrivateKey = await importPrivateKey(pemBody(signingKeys.privateKey));
  keyStore.setPrivateKey(signingPrivateKey);

  const encryptionKeys = await generateE2EEKeyMaterial();
  const publicBundle = bundle(encryptionKeys);
  const proof = await createSignedAction('e2ee_key_bundle', publicBundle, did, 'alice');

  return {
    response: {
      bundle: publicBundle,
      proof,
      signingPublicKey: signingKeys.publicKey,
    },
    signingPublicKey: signingKeys.publicKey,
  };
}

afterEach(() => clearUserPrivateKey());

describe('did:key E2EE bundle binding', () => {
  it('binds an actual generated PEM key through a canonical DER DID', async () => {
    const signingKeys = await generatePemKeyPair();
    const did = generateDID(signingKeys.publicKey);
    const signingPrivateKey = await importPrivateKey(pemBody(signingKeys.privateKey));
    keyStore.setPrivateKey(signingPrivateKey);

    const encryptionKeys = await generateE2EEKeyMaterial();
    const publicBundle = bundle(encryptionKeys);
    const proof = await createSignedAction('e2ee_key_bundle', publicBundle, did, 'alice');
    const response = { bundle: publicBundle, proof, signingPublicKey: signingKeys.publicKey };

    const didBytes = base58btc.decode(did.slice('did:key:'.length));
    expect(didBytes).toHaveLength(91);
    expect(Buffer.from(didBytes).toString('base64'))
      .toBe(normalizeSigningPublicKey(signingKeys.publicKey));
    expect(signingPublicKeyFromDid(did)).toBe(normalizeSigningPublicKey(signingKeys.publicKey));
    expect(didKeyMatchesPublicKey(did, signingKeys.publicKey)).toBe(true);
    await expect(verifyE2EEPublicBundle(response, did)).resolves.toBe(true);
  });

  it('verifies the exact historical PEM-as-base64 DID without accepting arbitrary prefixes', async () => {
    const signingKeys = await generatePemKeyPair();
    const legacyDid = `did:key:${base58btc.encode(
      new Uint8Array(Buffer.from(signingKeys.publicKey, 'base64')),
    )}`;
    const signingPrivateKey = await importPrivateKey(pemBody(signingKeys.privateKey));
    keyStore.setPrivateKey(signingPrivateKey);

    const encryptionKeys = await generateE2EEKeyMaterial();
    const publicBundle = bundle(encryptionKeys);
    const proof = await createSignedAction('e2ee_key_bundle', publicBundle, legacyDid, 'alice');
    const response = { bundle: publicBundle, proof, signingPublicKey: signingKeys.publicKey };

    expect(signingPublicKeyFromDid(legacyDid)).toBe(normalizeSigningPublicKey(signingKeys.publicKey));
    expect(didKeyMatchesPublicKey(legacyDid, signingKeys.publicKey)).toBe(true);
    await expect(verifyE2EEPublicBundle(response, legacyDid)).resolves.toBe(true);

    const legacyBytes = base58btc.decode(legacyDid.slice('did:key:'.length));
    const wrongPrefix = legacyBytes.slice();
    wrongPrefix[0] ^= 0x01;
    const malformedDid = `did:key:${base58btc.encode(wrongPrefix)}`;
    const malformedProof = await createSignedAction(
      'e2ee_key_bundle',
      publicBundle,
      malformedDid,
      'alice',
    );

    expect(signingPublicKeyFromDid(malformedDid)).toBeNull();
    await expect(verifyE2EEPublicBundle({ ...response, proof: malformedProof }, malformedDid))
      .resolves.toBe(false);
  });

  it('rejects a different signing key even when it signs a proof naming the expected DID', async () => {
    const owner = await generatePemKeyPair();
    const ownerDid = generateDID(owner.publicKey);
    const attacker = await signedBundleResponse(ownerDid);

    await expect(verifyE2EEPublicBundle(attacker.response, ownerDid)).resolves.toBe(false);
  });
});
