import crypto from 'node:crypto';
import { importPublicKey } from '@/lib/crypto/user-signing';

export const CLI_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
export const CLI_AUTHORIZATION_POLL_INTERVAL_SECONDS = 3;
export const CLI_CREDENTIAL_LIFETIME_DAYS_DEFAULT = 90;
export const CLI_CREDENTIAL_LIFETIME_DAYS_MAX = 365;

function publicKeyBytes(publicKey: string): Buffer {
  const clean = publicKey
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s/g, '');
  return Buffer.from(clean, 'base64');
}

export function createCliDeviceCode(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashCliDeviceCode(deviceCode: string): string {
  return crypto.createHash('sha256').update(deviceCode).digest('hex');
}

export function fingerprintCliPublicKey(publicKey: string): string {
  return crypto.createHash('sha256').update(publicKeyBytes(publicKey)).digest('hex');
}

export function formatCliFingerprint(fingerprint: string): string {
  return fingerprint.match(/.{1,4}/g)?.join(' ') ?? fingerprint;
}

export async function validateCliPublicKey(publicKey: string): Promise<void> {
  if (publicKeyBytes(publicKey).length === 0) throw new Error('INVALID_PUBLIC_KEY');
  const key = await importPublicKey(publicKey);
  const algorithm = key.algorithm as EcKeyAlgorithm;
  if (key.type !== 'public' || algorithm.name !== 'ECDSA' || algorithm.namedCurve !== 'P-256') {
    throw new Error('INVALID_PUBLIC_KEY');
  }
}
