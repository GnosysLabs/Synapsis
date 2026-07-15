import { base58btc } from 'multiformats/bases/base58';

// DER SubjectPublicKeyInfo prefix for an uncompressed ECDSA P-256 public key.
// The remaining 64 bytes are the affine X and Y coordinates.
const P256_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48,
  0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48,
  0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04,
]);

// Historical generateDID() passed the complete PEM string to
// Buffer.from(value, 'base64'). Node treats the five '-' characters on each
// side of BEGIN PUBLIC KEY as base64url data, producing this exact 18-byte
// prefix before the otherwise valid SPKI DER bytes.
const LEGACY_PEM_AS_BASE64_PREFIX = Uint8Array.from([
  0xfb, 0xef, 0xbe, 0xf8, 0x11, 0x06, 0x20, 0xd3, 0xd4,
  0x04, 0xb2, 0x02, 0x28, 0x46, 0x3e, 0xfb, 0xef, 0xbe,
]);

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function strictBase64ToBytes(value: string): Uint8Array | null {
  const unpadded = value.replace(/=+$/, '');
  if (
    !unpadded
    || unpadded.length % 4 === 1
    || !/^[A-Za-z0-9+/]+$/.test(unpadded)
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    return null;
  }

  try {
    const padded = unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return bytesToBase64(bytes).replace(/=+$/, '') === unpadded ? bytes : null;
  } catch {
    return null;
  }
}

function isP256SpkiDer(bytes: Uint8Array): boolean {
  return bytes.length === P256_SPKI_PREFIX.length + 64
    && startsWith(bytes, P256_SPKI_PREFIX);
}

/**
 * Normalize a PEM or base64 SPKI ECDSA P-256 public key to canonical DER.
 */
export function signingPublicKeyDer(publicKey: string): Uint8Array | null {
  const trimmed = publicKey.trim();
  let encoded = trimmed;

  if (trimmed.includes('-----BEGIN')) {
    const match = trimmed.match(
      /^-----BEGIN PUBLIC KEY-----\s+([A-Za-z0-9+/=\s]+?)\s+-----END PUBLIC KEY-----$/,
    );
    if (!match) return null;
    encoded = match[1].replace(/\s/g, '');
  } else if (/\s/.test(trimmed)) {
    return null;
  }

  const bytes = strictBase64ToBytes(encoded);
  return bytes && isP256SpkiDer(bytes) ? bytes : null;
}

export function normalizeSigningPublicKey(publicKey: string): string | null {
  const bytes = signingPublicKeyDer(publicKey);
  return bytes ? bytesToBase64(bytes) : null;
}

/**
 * Generate the project's did:key representation from canonical SPKI DER.
 */
export function generateDID(publicKey: string): string {
  const bytes = signingPublicKeyDer(publicKey);
  if (!bytes) throw new Error('Invalid ECDSA P-256 public key');
  return `did:key:${base58btc.encode(bytes)}`;
}

/**
 * Recover the canonical signing key from a project did:key. Historical DIDs
 * are accepted only when they have the exact prefix emitted by the old PEM
 * decoding bug and a valid P-256 SPKI DER suffix.
 */
export function signingPublicKeyFromDid(did: string): string | null {
  if (!did.startsWith('did:key:')) return null;

  try {
    const encoded = base58btc.decode(did.slice('did:key:'.length));
    if (isP256SpkiDer(encoded)) return bytesToBase64(encoded);

    if (
      encoded.length === LEGACY_PEM_AS_BASE64_PREFIX.length + P256_SPKI_PREFIX.length + 64
      && startsWith(encoded, LEGACY_PEM_AS_BASE64_PREFIX)
    ) {
      const der = encoded.slice(LEGACY_PEM_AS_BASE64_PREFIX.length);
      if (isP256SpkiDer(der)) return bytesToBase64(der);
    }
  } catch {
    return null;
  }

  return null;
}

export function didKeyMatchesPublicKey(did: string, publicKey: string): boolean {
  const didPublicKey = signingPublicKeyFromDid(did);
  const normalizedPublicKey = normalizeSigningPublicKey(publicKey);
  return didPublicKey !== null && didPublicKey === normalizedPublicKey;
}
