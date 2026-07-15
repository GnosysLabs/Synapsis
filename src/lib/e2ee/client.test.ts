import { afterEach, describe, expect, it } from 'vitest';

import {
  clearUserPrivateKey,
  createSignedAction,
  exportPublicKey,
  generateKeyPair,
  keyStore,
} from '@/lib/crypto/user-signing';
import { decryptStoredChatMessage } from './client';
import { verifyE2EEPublicBundle } from './bundle-proof';
import { encryptE2EEMessage, generateE2EEKeyMaterial } from './client-crypto';
import { E2EE_PROTOCOL, type E2EEKeyBundle } from './protocol';

const senderDid = 'did:synapsis:alice-signature-test';
const recipientDid = 'did:synapsis:bob-signature-test';

function bundle(
  material: Awaited<ReturnType<typeof generateE2EEKeyMaterial>>,
): E2EEKeyBundle {
  return {
    protocol: E2EE_PROTOCOL,
    keyId: material.keyId,
    version: 1,
    publicKey: material.publicKey,
    createdAt: Date.now(),
    recoveryCommitment: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  };
}

afterEach(() => clearUserPrivateKey());

describe('stored encrypted messages', () => {
  it('verifies the outer account signature before decrypting', async () => {
    const signingKeys = await generateKeyPair();
    const signingPublicKey = await exportPublicKey(signingKeys.publicKey);
    keyStore.setPrivateKey(signingKeys.privateKey);

    const sender = await generateE2EEKeyMaterial();
    const recipient = await generateE2EEKeyMaterial();
    const envelope = await encryptE2EEMessage({
      plaintext: 'signed and encrypted',
      senderDid,
      senderHandle: 'alice',
      senderBundle: bundle(sender),
      recipientDid,
      recipientHandle: 'bob',
      recipientBundle: bundle(recipient),
    });
    const signedAction = await createSignedAction(
      'chat_e2ee',
      envelope,
      senderDid,
      'alice',
    );

    await expect(decryptStoredChatMessage({
      protocolVersion: 1,
      encryptedEnvelope: envelope,
      signedAction,
      senderPublicKey: signingPublicKey,
    }, recipientDid, recipient)).resolves.toEqual({
      content: 'signed and encrypted',
      legacy: false,
    });

    const invalidSignature = {
      ...signedAction,
      sig: `${signedAction.sig.startsWith('A') ? 'B' : 'A'}${signedAction.sig.slice(1)}`,
    };
    await expect(decryptStoredChatMessage({
      protocolVersion: 1,
      encryptedEnvelope: envelope,
      signedAction: invalidSignature,
      senderPublicKey: signingPublicKey,
    }, recipientDid, recipient)).rejects.toThrow(/signature/);
  });

  it('rejects a stored envelope that differs from the signed envelope', async () => {
    const signingKeys = await generateKeyPair();
    const signingPublicKey = await exportPublicKey(signingKeys.publicKey);
    keyStore.setPrivateKey(signingKeys.privateKey);
    const sender = await generateE2EEKeyMaterial();
    const recipient = await generateE2EEKeyMaterial();
    const envelope = await encryptE2EEMessage({
      plaintext: 'original',
      senderDid,
      senderHandle: 'alice',
      senderBundle: bundle(sender),
      recipientDid,
      recipientHandle: 'bob',
      recipientBundle: bundle(recipient),
    });
    const signedAction = await createSignedAction('chat_e2ee', envelope, senderDid, 'alice');

    await expect(decryptStoredChatMessage({
      protocolVersion: 1,
      encryptedEnvelope: { ...envelope, ciphertext: `${envelope.ciphertext}A` },
      signedAction,
      senderPublicKey: signingPublicKey,
    }, recipientDid, recipient)).rejects.toThrow();
  });
});

describe('signed encryption key bundles', () => {
  it('accepts the DID-signing-key proof and rejects altered key material', async () => {
    const signingKeys = await generateKeyPair();
    const signingPublicKey = await exportPublicKey(signingKeys.publicKey);
    keyStore.setPrivateKey(signingKeys.privateKey);
    const material = await generateE2EEKeyMaterial();
    const publicBundle = bundle(material);
    const proof = await createSignedAction('e2ee_key_bundle', publicBundle, senderDid, 'alice');
    const response = { bundle: publicBundle, proof, signingPublicKey };

    await expect(verifyE2EEPublicBundle(response, senderDid)).resolves.toBe(true);
    await expect(verifyE2EEPublicBundle({
      ...response,
      bundle: { ...publicBundle, version: 2 },
    }, senderDid)).resolves.toBe(false);
  });
});
