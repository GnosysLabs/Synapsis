import crypto from 'node:crypto';

function pushCredentialKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('AUTH_SECRET is required for native push delivery');
  }
  return crypto.createHash('sha256').update(`push-delivery:${secret}`).digest();
}

function context(userId: string, installationId: string): string {
  return `push-subscription:${userId}:${installationId}`;
}

export function sealPushDeliveryToken(
  token: string,
  userId: string,
  installationId: string,
): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', pushCredentialKey(), iv);
  cipher.setAAD(Buffer.from(context(userId, installationId)));
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function openPushDeliveryToken(
  sealed: string,
  userId: string,
  installationId: string,
): string {
  const raw = Buffer.from(sealed, 'base64url');
  if (raw.length < 29) throw new Error('Invalid encrypted push delivery token');
  const decipher = crypto.createDecipheriv('aes-256-gcm', pushCredentialKey(), raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(context(userId, installationId)));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
