import sodium from 'libsodium-wrappers-sumo';

import { canonicalize, verifySignedActionSignature } from '@/lib/crypto/user-signing';
import {
  normalizeSigningPublicKey,
  signingPublicKeyFromDid,
} from '@/lib/crypto/did-key';
import {
  E2EE_KEY_BUNDLE_ACTION,
  e2eeKeyBundleSchema,
  signedUserActionSchema,
  type E2EEPublicBundleResponse,
} from './protocol';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function encryptionKeyIdFromPublicKey(publicKey: string): Promise<string | null> {
  try {
    await sodium.ready;
    const key = base64UrlToBytes(publicKey);
    if (key.length !== sodium.crypto_box_PUBLICKEYBYTES) return null;
    return `k1_${bytesToBase64Url(sodium.crypto_generichash(16, key, null))}`;
  } catch {
    return null;
  }
}

export { signingPublicKeyFromDid } from '@/lib/crypto/did-key';

export async function verifyE2EEPublicBundle(
  response: E2EEPublicBundleResponse,
  expectedDid: string,
): Promise<boolean> {
  const proofResult = signedUserActionSchema.safeParse(response.proof);
  const bundleResult = e2eeKeyBundleSchema.safeParse(response.bundle);
  if (!proofResult.success || !bundleResult.success) return false;

  const proof = proofResult.data;
  if (proof.action !== E2EE_KEY_BUNDLE_ACTION || proof.did !== expectedDid) return false;

  const proofBundle = e2eeKeyBundleSchema.safeParse(proof.data);
  if (!proofBundle.success || canonicalize(proofBundle.data) !== canonicalize(bundleResult.data)) {
    return false;
  }

  if (await encryptionKeyIdFromPublicKey(bundleResult.data.publicKey) !== bundleResult.data.keyId) {
    return false;
  }

  const responseSigningPublicKey = normalizeSigningPublicKey(response.signingPublicKey);
  if (!responseSigningPublicKey) return false;

  const didSigningPublicKey = signingPublicKeyFromDid(expectedDid);
  if (expectedDid.startsWith('did:key:') && !didSigningPublicKey) return false;
  if (didSigningPublicKey && didSigningPublicKey !== responseSigningPublicKey) return false;
  const signingPublicKey = didSigningPublicKey || responseSigningPublicKey;
  if (!signingPublicKey) return false;
  return verifySignedActionSignature(proof, signingPublicKey);
}
