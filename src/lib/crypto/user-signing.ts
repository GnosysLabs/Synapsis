/**
 * User-Level Cryptographic Signing
 * 
 * Strict Implementation Rules:
 * - ECDSA P-256 (ES256) ONLY. No RSA.
 * - Private keys NEVER in localStorage (decrypted).
 * - Keys stored in memory only (InMemoryKeyStore).
 * - Canonicalization: JSON with sorted keys, no floats, no dates.
 * - Nonce: 16+ bytes random base64url.
 */

// ============================================
// KEY STORAGE (In-Memory Only)
// ============================================

export interface KeyStore {
  setPrivateKey(key: CryptoKey): void;
  getPrivateKey(): CryptoKey | null;
  setIdentity(data: { did: string; handle: string; publicKey: string }): void;
  getIdentity(): { did: string; handle: string; publicKey: string } | null;
  clear(): void;
}

class InMemoryKeyStore implements KeyStore {
  private static instance: InMemoryKeyStore;
  private privateKey: CryptoKey | null = null;
  private identity: { did: string; handle: string; publicKey: string } | null = null;


  private constructor() { }

  static getInstance(): InMemoryKeyStore {
    if (!InMemoryKeyStore.instance) {
      InMemoryKeyStore.instance = new InMemoryKeyStore();
    }
    return InMemoryKeyStore.instance;
  }

  setPrivateKey(key: CryptoKey): void {
    if (key.type !== 'private' || key.algorithm.name !== 'ECDSA') {
      throw new Error('Invalid key type: Must be ECDSA private key');
    }
    this.privateKey = key;
  }

  getPrivateKey(): CryptoKey | null {
    return this.privateKey;
  }

  setIdentity(data: { did: string; handle: string; publicKey: string }): void {
    this.identity = data;
  }

  getIdentity() {
    return this.identity;
  }



  clear(): void {
    this.privateKey = null;
    this.identity = null;
  }
}

export const keyStore = InMemoryKeyStore.getInstance();

export function hasUserPrivateKey(): boolean {
  return keyStore.getPrivateKey() !== null;
}

export function clearUserPrivateKey(): void {
  keyStore.clear();
}

// ============================================
// CRYPTO HELPERS (WebCrypto / Node)
// ============================================

// Modern browsers and the supported Node.js runtime both expose WebCrypto.
const cryptoSubtle = globalThis.crypto?.subtle;

if (!cryptoSubtle) {
  throw new Error('WebCrypto is not supported in this environment');
}

/**
 * Generate a new ECDSA P-256 KeyPair
 * Non-extractable private key by default (good practice), 
 * but we need to export it to encrypt with password.
 */
export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return await cryptoSubtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true, // extractable (needed for export/encyrption)
    ['sign', 'verify']
  );
}

/**
 * Export Private Key to PKCS8 (for encryption/storage)
 */
export async function exportPrivateKey(key: CryptoKey): Promise<ArrayBuffer> {
  return await cryptoSubtle.exportKey('pkcs8', key);
}

/**
 * Import Private Key from PKCS8 (after decryption)
 */
export async function importPrivateKey(keyData: ArrayBuffer | Uint8Array): Promise<CryptoKey> {
  const normalizedKeyData = keyData instanceof ArrayBuffer
    ? keyData
    : Uint8Array.from(keyData).buffer;
  return await cryptoSubtle.importKey(
    'pkcs8',
    normalizedKeyData,
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    false, // not exportable once imported in memory
    ['sign']
  );
}

/**
 * Export Public Key to SPKI (for distribution)
 * We usually want this as PEM or JWK. Let's stick to PEM buffer for consistency 
 * with existing storage, or simpler: just keep SPKI buffer and base64 it.
 */
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const exported = await cryptoSubtle.exportKey('spki', key);
  return arrayBufferToBase64(exported);
}

/**
 * Import Public Key from SPKI Base64 (for verification)
 */
export async function importPublicKey(base64Key: string): Promise<CryptoKey> {
  // Strip PEM headers and whitespace/newlines if present
  const cleanKey = base64Key
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/[\s\n\r]/g, '');

  const binary = base64ToArrayBuffer(cleanKey);
  return await cryptoSubtle.importKey(
    'spki',
    binary,
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true,
    ['verify']
  );
}

// ============================================
// SIGNING & CANONICALIZATION
// ============================================

/**
 * Strict Canonicalization for Signing
 * - Request strict sorted keys
 * - No Dates, Maps, Sets, Functions
 * - No NaN, Infinity
 */
export function canonicalize(obj: unknown): string {
  if (obj === undefined) return ''; // Should not happen for valid inputs
  if (obj === null) return 'null';

  if (typeof obj === 'number') {
    if (!Number.isFinite(obj)) {
      throw new Error('De-serialization failed: Number is not finite');
    }
    return obj.toString();
  }

  if (typeof obj === 'boolean') {
    return obj.toString();
  }

  if (typeof obj === 'string') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    const items = obj.map(item => canonicalize(item)).join(',');
    return `[${items}]`;
  }

  if (typeof obj === 'object') {
    // Reject forbidden types
    if (obj instanceof Date) throw new Error('Serialization failed: Date objects not allowed');
    if (obj instanceof RegExp) throw new Error('Serialization failed: RegExp objects not allowed');

    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const pairs: string[] = [];

    for (const key of keys) {
      if (record[key] === undefined) continue;
      const val = canonicalize(record[key]);
      pairs.push(`${JSON.stringify(key)}:${val}`);
    }

    return `{${pairs.join(',')}}`;
  }

  throw new Error(`Serialization failed: Unsupported type ${typeof obj}`);
}

/**
 * Create a Signed Action
 * @returns { SignedAction } Includes ts, nonce, and strict signature
 */
export async function createSignedAction<TData>(
  action: string,
  data: TData,
  userDid: string,
  userHandle: string
): Promise<{
  action: string;
  data: TData;
  did: string;
  handle: string;
  ts: number;
  nonce: string;
  sig: string;
}> {
  const privateKey = keyStore.getPrivateKey();
  if (!privateKey) {
    throw new Error('User private key not available. Please log in (unlock identity).');
  }

  const ts = Date.now();
  // 16 bytes entropy for nonce
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = arrayBufferToBase64Url(nonceBytes);

  // Payload strictly ordered for signing
  // We construct the object that matches the canonical structure EXACTLY
  const payloadToSign = {
    action,
    data,
    did: userDid,
    handle: userHandle,
    nonce,
    ts
  };

  const canonicalString = canonicalize(payloadToSign);
  const encoder = new TextEncoder();
  const dataBytes = encoder.encode(canonicalString);

  const signatureBuffer = await cryptoSubtle.sign(
    {
      name: 'ECDSA',
      hash: { name: 'SHA-256' },
    },
    privateKey,
    dataBytes
  );

  const sig = arrayBufferToBase64Url(signatureBuffer);

  return {
    ...payloadToSign,
    sig
  };
}

export async function verifySignedActionSignature(
  signedAction: {
    action: string;
    data: unknown;
    did: string;
    handle: string;
    ts: number;
    nonce: string;
    sig: string;
  },
  publicKeyString: string,
): Promise<boolean> {
  try {
    const { sig, ...payload } = signedAction;
    const canonicalString = canonicalize(payload);
    const signature = base64ToArrayBuffer(base64UrlToBase64(sig));
    const publicKey = await importPublicKey(publicKeyString);
    return cryptoSubtle.verify(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      publicKey,
      signature,
      new TextEncoder().encode(canonicalString),
    );
  } catch {
    return false;
  }
}


// ============================================
// UTILS
// ============================================

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function arrayBufferToBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Helper to convert Base64URL to Base64 (standard) for importing keys if needed
 */
export function base64UrlToBase64(base64Url: string): string {
  let base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return base64;
}
