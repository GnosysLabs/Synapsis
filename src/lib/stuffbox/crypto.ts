import crypto from 'node:crypto';

function key(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) throw new Error('AUTH_SECRET is required for Stuffbox');
  return crypto.createHash('sha256').update(`stuffbox:${secret}`).digest();
}

export function sealStuffboxSecret(value: string, context: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function openStuffboxSecret(value: string, context: string): string {
  const raw = Buffer.from(value, 'base64url');
  if (raw.length < 29) throw new Error('Invalid encrypted Stuffbox value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

export function generatePkce(): { verifier: string; challenge: string; state: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return {
    verifier,
    challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    state: crypto.randomBytes(32).toString('base64url'),
  };
}
