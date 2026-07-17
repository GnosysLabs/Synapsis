import { createHash, randomBytes, webcrypto } from 'node:crypto';

const { subtle } = webcrypto;

export function canonicalize(value) {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot sign a non-finite number');
    return value.toString();
  }
  if (typeof value === 'boolean') return value.toString();
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    if (value instanceof Date || value instanceof RegExp) throw new Error('Unsupported signed value');
    return `{${Object.keys(value).sort().flatMap(key => {
      if (value[key] === undefined) return [];
      return [`${JSON.stringify(key)}:${canonicalize(value[key])}`];
    }).join(',')}}`;
  }
  throw new Error(`Unsupported signed value: ${typeof value}`);
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

export async function generateCredentialKeyPair() {
  const keyPair = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const [publicKey, privateKey] = await Promise.all([
    subtle.exportKey('spki', keyPair.publicKey),
    subtle.exportKey('pkcs8', keyPair.privateKey),
  ]);
  return {
    publicKey: Buffer.from(publicKey).toString('base64'),
    privateKey: Buffer.from(privateKey).toString('base64'),
    fingerprint: createHash('sha256').update(Buffer.from(publicKey)).digest('hex'),
  };
}

export async function signAction(profile, action, data, options = {}) {
  const privateKey = await subtle.importKey(
    'pkcs8',
    Buffer.from(profile.privateKey, 'base64'),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const payload = {
    action,
    data,
    credentialId: profile.credentialId,
    nonce: options.nonce || randomBytes(16).toString('base64url'),
    ts: options.ts || Date.now(),
  };
  const signature = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(canonicalize(payload)),
  );
  return { ...payload, sig: base64Url(signature) };
}
