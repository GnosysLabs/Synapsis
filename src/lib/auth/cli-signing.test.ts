import { describe, expect, it } from 'vitest';
import { generateCredentialKeyPair, signAction } from '../../../packages/cli/src/signing.js';
import { requireSignedAction, verifyCanonicalSignature } from './verify-signature';

describe('Synapsis CLI signing compatibility', () => {
  it('verifies a CLI-produced P-256 action with the server verifier', async () => {
    const keys = await generateCredentialKeyPair();
    const signed = await signAction({
      credentialId: '00000000-0000-4000-8000-000000000001',
      privateKey: keys.privateKey,
    }, 'post', {
      content: 'Signed by the CLI',
      mediaIds: [],
      isNsfw: false,
    }, {
      nonce: 'fixed-cli-nonce',
      ts: 1_700_000_000_000,
    });

    await expect(verifyCanonicalSignature(signed, keys.publicKey)).resolves.toBe(true);
  });

  it('rejects a non-canonical base64url spelling of valid signature bytes', async () => {
    const keys = await generateCredentialKeyPair();
    const signed = await signAction({
      credentialId: '00000000-0000-4000-8000-000000000001',
      privateKey: keys.privateKey,
    }, 'post', {
      content: 'Signed by the CLI',
      mediaIds: [],
      isNsfw: false,
    }, {
      nonce: 'fixed-cli-nonce',
      ts: 1_700_000_000_000,
    });

    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const finalIndex = alphabet.indexOf(signed.sig.at(-1) ?? '');
    expect(finalIndex).toBeGreaterThanOrEqual(0);
    expect(finalIndex % 16).toBe(0);
    const nonCanonicalSig = `${signed.sig.slice(0, -1)}${alphabet[finalIndex + 1]}`;
    expect(Buffer.from(nonCanonicalSig, 'base64url')).toEqual(
      Buffer.from(signed.sig, 'base64url'),
    );

    await expect(verifyCanonicalSignature({
      ...signed,
      sig: nonCanonicalSig,
    }, keys.publicKey)).resolves.toBe(false);
  });

  it('rejects an unexpected account action before identity lookup', async () => {
    await expect(requireSignedAction({
      action: 'like',
      data: {},
      did: 'did:key:test',
      handle: 'test',
      ts: Date.now(),
      nonce: 'fixed-nonce',
      sig: 'invalid',
    }, 'post')).rejects.toMatchObject({ code: 'INVALID_ACTION' });
  });
});
