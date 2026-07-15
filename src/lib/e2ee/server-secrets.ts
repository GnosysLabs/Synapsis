import crypto from 'node:crypto';

function recoverySecret(): string {
  const secret = process.env.E2EE_RECOVERY_SECRET;
  if (!secret || secret.length < 32 || secret === 'replace-with-a-separate-long-random-secret') {
    throw new Error('A high-entropy E2EE_RECOVERY_SECRET is required for encrypted message recovery');
  }
  if (secret === process.env.AUTH_SECRET) {
    throw new Error('E2EE_RECOVERY_SECRET must be independent of AUTH_SECRET');
  }
  return secret;
}

function encryptionKey(): Buffer {
  return crypto.createHash('sha256').update(`synapsis:e2ee:server-share:v1:${recoverySecret()}`).digest();
}

function verifierKey(): Buffer {
  return crypto.createHash('sha256').update(`synapsis:e2ee:pin-verifier:v1:${recoverySecret()}`).digest();
}

export function sealServerShare(value: string, userId: string, keyId: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(`${userId}:${keyId}`));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

export function openServerShare(value: string, userId: string, keyId: string): string {
  const raw = Buffer.from(value, 'base64url');
  if (raw.length < 29) throw new Error('Invalid encrypted recovery share');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(`${userId}:${keyId}`));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

export function createPinVerifierMac(pinVerifier: string, userId: string, keyId: string): string {
  return crypto
    .createHmac('sha256', verifierKey())
    .update(`${userId}:${keyId}:`)
    .update(pinVerifier)
    .digest('base64url');
}

export function pinVerifierMatches(
  candidate: string,
  expectedMac: string,
  userId: string,
  keyId: string,
): boolean {
  const actual = Buffer.from(createPinVerifierMac(candidate, userId, keyId), 'base64url');
  const expected = Buffer.from(expectedMac, 'base64url');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
