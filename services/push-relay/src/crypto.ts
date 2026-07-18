import crypto from 'node:crypto';

export function generateBearerToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(tokenHash(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function sealDeviceToken(token: string, subscriptionId: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`apns-device:${subscriptionId}`));
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function openDeviceToken(sealed: string, subscriptionId: string, key: Buffer): string {
  const raw = Buffer.from(sealed, 'base64url');
  if (raw.length < 29) throw new Error('Invalid encrypted APNs device token');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(`apns-device:${subscriptionId}`));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
