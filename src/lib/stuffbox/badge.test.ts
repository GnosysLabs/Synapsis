import { describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from 'jose';
import { verifyStuffboxBadgeAttestation } from './badge';

async function issueBadge(input: {
  subject?: string;
  level?: 'connected' | 'supporter';
  plan?: 'free' | 'plus';
}) {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  const jwk = await exportJWK(publicKey);
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    level: input.level ?? 'connected',
    plan: input.plan ?? 'free',
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'stuffbox-badge-v1', typ: 'JWT' })
    .setIssuer('https://stuffbox.example')
    .setAudience('synapsis')
    .setSubject(input.subject ?? 'alice@node.example')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);
  return {
    token,
    jwks: { keys: [{ ...jwk, kid: 'stuffbox-badge-v1', use: 'sig', alg: 'EdDSA' }] } as JSONWebKeySet,
  };
}

describe('Stuffbox badge verification', () => {
  it('accepts a signed proof bound to the exact canonical account', async () => {
    const { token, jwks } = await issueBadge({});
    await expect(verifyStuffboxBadgeAttestation(token, '@Alice@Node.Example', {
      jwks,
      issuer: 'https://stuffbox.example',
    })).resolves.toMatchObject({ level: 'connected', plan: 'free' });
  });

  it('rejects a valid proof copied onto another account', async () => {
    const { token, jwks } = await issueBadge({});
    await expect(verifyStuffboxBadgeAttestation(token, 'mallory@node.example', {
      jwks,
      issuer: 'https://stuffbox.example',
    })).resolves.toBeNull();
  });

  it('rejects a supporter level attached to the free plan', async () => {
    const { token, jwks } = await issueBadge({ level: 'supporter', plan: 'free' });
    await expect(verifyStuffboxBadgeAttestation(token, 'alice@node.example', {
      jwks,
      issuer: 'https://stuffbox.example',
    })).resolves.toBeNull();
  });
});
