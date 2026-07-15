import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createE2EEVault,
  decryptE2EEMessage,
  encryptE2EEMessage,
  fromBase64Url,
  generateE2EEKeyMaterial,
  openE2EEVault,
  prepareE2EEVaultUnlock,
  toBase64Url,
} from './client-crypto';
import {
  E2EE_PROTOCOL,
  e2eeMessageEnvelopeSchema,
  validateMessageBindings,
  type E2EEKeyBundle,
  type E2EEMessageEnvelope,
} from './protocol';
import {
  createPinVerifierMac,
  openServerShare,
  pinVerifierMatches,
  sealServerShare,
} from './server-secrets';

const aliceDid = 'did:key:alice-test-identity';
const bobDid = 'did:key:bob-test-identity';

function bundle(
  material: Awaited<ReturnType<typeof generateE2EEKeyMaterial>>,
  version = 1,
): E2EEKeyBundle {
  return {
    protocol: E2EE_PROTOCOL,
    keyId: material.keyId,
    version,
    publicKey: material.publicKey,
    createdAt: 1_700_000_000_000,
    recoveryCommitment: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  };
}

function flipEncodedByte(value: string): string {
  const bytes = fromBase64Url(value);
  bytes[Math.floor(bytes.length / 2)] ^= 1;
  return toBase64Url(bytes);
}

async function messageFixture() {
  const alice = await generateE2EEKeyMaterial();
  const bob = await generateE2EEKeyMaterial();
  const envelope = await encryptE2EEMessage({
    plaintext: 'the server should never receive this text',
    senderDid: aliceDid,
    senderHandle: 'alice',
    senderBundle: bundle(alice),
    recipientDid: bobDid,
    recipientHandle: 'bob',
    recipientBundle: bundle(bob),
  });
  return { alice, bob, envelope };
}

describe('E2EE message crypto', () => {
  it('decrypts the same envelope for both sender and recipient', async () => {
    const { alice, bob, envelope } = await messageFixture();

    await expect(decryptE2EEMessage(envelope, aliceDid, alice))
      .resolves.toBe('the server should never receive this text');
    await expect(decryptE2EEMessage(envelope, bobDid, bob))
      .resolves.toBe('the server should never receive this text');
  });

  it('rejects an unrelated private key', async () => {
    const { envelope } = await messageFixture();
    const mallory = await generateE2EEKeyMaterial();
    await expect(decryptE2EEMessage(envelope, bobDid, mallory)).rejects.toThrow();
  });

  it.each(['ciphertext', 'nonce', 'keyCommitment'] as const)(
    'rejects a modified %s',
    async (field) => {
      const { bob, envelope } = await messageFixture();
      const tampered = { ...envelope, [field]: flipEncodedByte(envelope[field]) };
      await expect(decryptE2EEMessage(tampered, bobDid, bob)).rejects.toThrow();
    },
  );

  it('rejects authenticated-header tampering', async () => {
    const { bob, envelope } = await messageFixture();
    const tampered = { ...envelope, conversationId: `${envelope.conversationId}x` };
    await expect(decryptE2EEMessage(tampered, bobDid, bob)).rejects.toThrow(/transplanted/);
  });

  it('rejects sealed-key transplantation between messages', async () => {
    const { alice, bob, envelope } = await messageFixture();
    const second = await encryptE2EEMessage({
      plaintext: 'second message',
      senderDid: aliceDid,
      senderHandle: 'alice',
      senderBundle: bundle(alice),
      recipientDid: bobDid,
      recipientHandle: 'bob',
      recipientBundle: bundle(bob),
    });
    const transplanted = { ...second, keyEnvelopes: envelope.keyEnvelopes };
    await expect(decryptE2EEMessage(transplanted, bobDid, bob)).rejects.toThrow(/transplanted/);
  });
});

describe('E2EE PIN vault', () => {
  it('round-trips only with the correct PIN and server share', async () => {
    const material = await generateE2EEKeyMaterial();
    const setup = await createE2EEVault('739184', material, aliceDid, 1);
    const prepared = await prepareE2EEVaultUnlock('739184', setup.vault);

    await expect(openE2EEVault(prepared, setup.vault, setup.serverShare)).resolves.toEqual(material);

    const wrong = await prepareE2EEVaultUnlock('739185', setup.vault);
    await expect(openE2EEVault(wrong, setup.vault, setup.serverShare)).rejects.toThrow();
  });

  it('binds a vault to its owner and key metadata', async () => {
    const material = await generateE2EEKeyMaterial();
    const setup = await createE2EEVault('739184', material, aliceDid, 1);
    const prepared = await prepareE2EEVaultUnlock('739184', setup.vault);
    const transplanted = { ...setup.vault, ownerDid: bobDid };

    await expect(openE2EEVault(prepared, transplanted, setup.serverShare)).rejects.toThrow();
  });
});

describe('E2EE protocol validation', () => {
  it('rejects unknown fields and unsupported suites', async () => {
    const { envelope } = await messageFixture();
    expect(e2eeMessageEnvelopeSchema.safeParse({ ...envelope, plaintext: 'leak' }).success).toBe(false);
    expect(e2eeMessageEnvelopeSchema.safeParse({ ...envelope, cipherSuite: 'unknown' }).success).toBe(false);
  });

  it('rejects duplicate and mismatched key-envelope bindings', async () => {
    const { envelope } = await messageFixture();
    const duplicate: E2EEMessageEnvelope = {
      ...envelope,
      keyEnvelopes: [envelope.keyEnvelopes[0], envelope.keyEnvelopes[0]],
    };
    expect(() => validateMessageBindings(duplicate, {
      action: 'chat_e2ee',
      did: envelope.senderDid,
      handle: envelope.senderHandle,
      ts: envelope.createdAt,
    })).toThrow(/duplicate/);
  });

  it('allows a stable old envelope to be re-signed for idempotent retry but rejects future dating', async () => {
    const { envelope } = await messageFixture();
    const action = {
      action: 'chat_e2ee',
      did: envelope.senderDid,
      handle: envelope.senderHandle,
      ts: envelope.createdAt + 24 * 60 * 60 * 1000,
    };
    expect(() => validateMessageBindings(envelope, action)).not.toThrow();
    expect(() => validateMessageBindings({
      ...envelope,
      createdAt: action.ts + 5 * 60 * 1000 + 1,
    }, action)).toThrow(/future/);
  });
});

describe('server recovery-secret protection', () => {
  beforeEach(() => {
    vi.stubEnv('E2EE_RECOVERY_SECRET', 'test-only-recovery-secret-with-entropy');
  });

  it('seals server shares to account and key context', () => {
    const sealed = sealServerShare('server-share', 'user-1', 'key-1');
    expect(openServerShare(sealed, 'user-1', 'key-1')).toBe('server-share');
    expect(() => openServerShare(sealed, 'user-2', 'key-1')).toThrow();
    expect(() => openServerShare(sealed, 'user-1', 'key-2')).toThrow();
  });

  it('compares PIN verifiers without accepting another context', () => {
    const mac = createPinVerifierMac('pin-proof', 'user-1', 'key-1');
    expect(pinVerifierMatches('pin-proof', mac, 'user-1', 'key-1')).toBe(true);
    expect(pinVerifierMatches('pin-proof', mac, 'user-2', 'key-1')).toBe(false);
    expect(pinVerifierMatches('other-proof', mac, 'user-1', 'key-1')).toBe(false);
  });

  it('rejects a missing, placeholder, or reused deployment secret', () => {
    vi.stubEnv('E2EE_RECOVERY_SECRET', 'replace-with-a-separate-long-random-secret');
    expect(() => sealServerShare('share', 'user-1', 'key-1')).toThrow(/high-entropy/);

    vi.stubEnv('E2EE_RECOVERY_SECRET', 'same-secret-that-is-long-enough-for-both-values');
    vi.stubEnv('AUTH_SECRET', 'same-secret-that-is-long-enough-for-both-values');
    expect(() => sealServerShare('share', 'user-1', 'key-1')).toThrow(/independent/);
  });
});
