import crypto from 'node:crypto';

const MAX_NODE_PUBLIC_KEY_LENGTH = 16 * 1024;

/**
 * Return one stable representation for a supported node identity key.
 * Formatting differences such as PEM trailing newlines must not look like a
 * key rotation, while a genuinely different key must still fail closed.
 */
export function normalizeSwarmNodePublicKey(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_NODE_PUBLIC_KEY_LENGTH) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const key = trimmed.includes('BEGIN PUBLIC KEY')
      ? crypto.createPublicKey(trimmed)
      : (() => {
          const encoded = trimmed.replace(/\s/g, '');
          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
            throw new Error('Invalid DER public key encoding');
          }
          return crypto.createPublicKey({
            key: Buffer.from(encoded, 'base64'),
            format: 'der',
            type: 'spki',
          });
        })();

    if (key.asymmetricKeyType !== 'ec'
      || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      return null;
    }

    return key.export({ type: 'spki', format: 'pem' }).toString().trim();
  } catch {
    return null;
  }
}
