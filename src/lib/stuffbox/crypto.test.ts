import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePkce, openStuffboxSecret, sealStuffboxSecret } from './crypto';

const previousSecret = process.env.AUTH_SECRET;

beforeAll(() => { process.env.AUTH_SECRET = 'stuffbox-test-secret-at-least-16-characters'; });
afterAll(() => {
  if (previousSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = previousSecret;
});

describe('Stuffbox secret protection', () => {
  it('round-trips secrets only with the matching context', () => {
    const sealed = sealStuffboxSecret('refresh-token', 'stuffbox:user-1:refresh');
    expect(openStuffboxSecret(sealed, 'stuffbox:user-1:refresh')).toBe('refresh-token');
    expect(() => openStuffboxSecret(sealed, 'stuffbox:user-2:refresh')).toThrow();
  });

  it('creates an S256 PKCE pair and independent state', async () => {
    const pkce = generatePkce();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pkce.verifier));
    const challenge = Buffer.from(digest).toString('base64url');
    expect(pkce.challenge).toBe(challenge);
    expect(pkce.state).not.toBe(pkce.verifier);
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);
  });
});
