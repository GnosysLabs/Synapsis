import sodium from 'libsodium-wrappers-sumo';
import { v4 as uuidv4 } from 'uuid';

import {
  E2EE_KDF,
  E2EE_CIPHER_SUITE,
  E2EE_MAX_MESSAGE_PLAINTEXT_BYTES,
  E2EE_PROTOCOL,
  type E2EEKeyBundle,
  type E2EEKeyMaterial,
  type E2EEMessageEnvelope,
  type E2EEVaultRecord,
  type E2EEVaultSetup,
  messageAuthenticatedData,
  validateLegacyPin,
  validateRecoveryPassword,
  vaultAuthenticatedData,
} from './protocol';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const PIN_VERIFIER_CONTEXT = encoder.encode('synapsis-e2ee-pin-verifier-v1');
const VAULT_KEY_CONTEXT = encoder.encode('synapsis-e2ee-vault-key-v1');

async function ready(): Promise<typeof sodium> {
  await sodium.ready;
  return sodium;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

async function deriveRecoveryKey(
  credential: string,
  salt: Uint8Array,
  opsLimit: number,
  memLimit: number,
  method: 'password' | 'legacy_pin',
): Promise<Uint8Array> {
  if (method === 'legacy_pin') validateLegacyPin(credential);
  else validateRecoveryPassword(credential);
  const crypto = await ready();
  return crypto.crypto_pwhash(
    32,
    credential,
    salt,
    opsLimit,
    memLimit,
    crypto.crypto_pwhash_ALG_ARGON2ID13,
  );
}

function deriveVerifier(crypto: typeof sodium, pinKey: Uint8Array): Uint8Array {
  return crypto.crypto_generichash(32, PIN_VERIFIER_CONTEXT, pinKey);
}

function deriveVaultKey(
  crypto: typeof sodium,
  pinKey: Uint8Array,
  serverShare: Uint8Array,
): Uint8Array {
  return crypto.crypto_generichash(32, concatBytes(VAULT_KEY_CONTEXT, serverShare), pinKey);
}

export async function generateE2EEKeyMaterial(): Promise<E2EEKeyMaterial> {
  const crypto = await ready();
  const pair = crypto.crypto_box_keypair();
  const fingerprint = crypto.crypto_generichash(16, pair.publicKey, null);
  return {
    keyId: `k1_${toBase64Url(fingerprint)}`,
    publicKey: toBase64Url(pair.publicKey),
    privateKey: toBase64Url(pair.privateKey),
  };
}

async function assertKeyMaterialMatchesPublicKey(material: E2EEKeyMaterial): Promise<void> {
  const crypto = await ready();
  const publicKey = fromBase64Url(material.publicKey);
  const privateKey = fromBase64Url(material.privateKey);
  try {
    if (publicKey.length !== crypto.crypto_box_PUBLICKEYBYTES
      || privateKey.length !== crypto.crypto_box_SECRETKEYBYTES) {
      throw new Error('Encrypted message key material has an invalid length');
    }
    const derivedPublicKey = crypto.crypto_scalarmult_base(privateKey);
    const fingerprint = crypto.crypto_generichash(16, publicKey, null);
    if (!crypto.memcmp(derivedPublicKey, publicKey)
      || material.keyId !== `k1_${toBase64Url(fingerprint)}`) {
      throw new Error('Encrypted message private key does not match its public key');
    }
  } finally {
    crypto.memzero(privateKey);
  }
}

export async function createE2EEVault(
  password: string,
  material: E2EEKeyMaterial,
  ownerDid: string,
  keyVersion: number,
): Promise<E2EEVaultSetup> {
  validateRecoveryPassword(password);
  const crypto = await ready();
  await assertKeyMaterialMatchesPublicKey(material);
  const salt = crypto.randombytes_buf(crypto.crypto_pwhash_SALTBYTES);
  const serverShare = crypto.randombytes_buf(32);
  const nonce = crypto.randombytes_buf(crypto.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  let pinKey: Uint8Array | null = null;
  let vaultKey: Uint8Array | null = null;
  let plaintext: Uint8Array | null = null;

  try {
    pinKey = await deriveRecoveryKey(password, salt, E2EE_KDF.opsLimit, E2EE_KDF.memLimit, 'password');
    vaultKey = deriveVaultKey(crypto, pinKey, serverShare);
    const vaultWithoutCiphertext = {
      protocol: E2EE_PROTOCOL,
      ownerDid,
      keyId: material.keyId,
      keyVersion,
      publicKey: material.publicKey,
      salt: toBase64Url(salt),
      kdfAlgorithm: E2EE_KDF.algorithm,
      kdfOpsLimit: E2EE_KDF.opsLimit,
      kdfMemLimit: E2EE_KDF.memLimit,
    } as const;
    plaintext = encoder.encode(JSON.stringify(material));
    const ciphertext = crypto.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      encoder.encode(vaultAuthenticatedData(vaultWithoutCiphertext)),
      null,
      nonce,
      vaultKey,
    );

    return {
      vault: {
        ...vaultWithoutCiphertext,
        ciphertext: toBase64Url(ciphertext),
        nonce: toBase64Url(nonce),
      },
      serverShare: toBase64Url(serverShare),
      pinVerifier: toBase64Url(deriveVerifier(crypto, pinKey)),
    } satisfies E2EEVaultSetup;
  } finally {
    if (pinKey) crypto.memzero(pinKey);
    if (vaultKey) crypto.memzero(vaultKey);
    if (plaintext) crypto.memzero(plaintext);
    crypto.memzero(serverShare);
  }
}

export interface PreparedVaultUnlock {
  pinKey: Uint8Array;
  pinVerifier: string;
}

export async function prepareE2EEVaultUnlock(
  credential: string,
  vault: Pick<E2EEVaultRecord, 'salt' | 'kdfOpsLimit' | 'kdfMemLimit'>,
  method: 'password' | 'legacy_pin' = 'password',
): Promise<PreparedVaultUnlock> {
  const crypto = await ready();
  const pinKey = await deriveRecoveryKey(
    credential,
    fromBase64Url(vault.salt),
    vault.kdfOpsLimit,
    vault.kdfMemLimit,
    method,
  );
  return {
    pinKey,
    pinVerifier: toBase64Url(deriveVerifier(crypto, pinKey)),
  };
}

export async function openE2EEVault(
  prepared: PreparedVaultUnlock,
  vault: E2EEVaultRecord,
  serverShareValue: string,
): Promise<E2EEKeyMaterial> {
  const crypto = await ready();
  let serverShare: Uint8Array | null = null;
  let vaultKey: Uint8Array | null = null;
  let plaintext: Uint8Array | null = null;

  try {
    serverShare = fromBase64Url(serverShareValue);
    vaultKey = deriveVaultKey(crypto, prepared.pinKey, serverShare);
    plaintext = crypto.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      fromBase64Url(vault.ciphertext),
      encoder.encode(vaultAuthenticatedData(vault)),
      fromBase64Url(vault.nonce),
      vaultKey,
    );
    const material = JSON.parse(decoder.decode(plaintext)) as E2EEKeyMaterial;
    if (material.keyId !== vault.keyId || material.publicKey !== vault.publicKey) {
      throw new Error('Encrypted message vault does not match its public key');
    }
    await assertKeyMaterialMatchesPublicKey(material);
    return material;
  } finally {
    crypto.memzero(prepared.pinKey);
    if (vaultKey) crypto.memzero(vaultKey);
    if (serverShare) crypto.memzero(serverShare);
    if (plaintext) crypto.memzero(plaintext);
  }
}

export async function encryptE2EEMessage(input: {
  plaintext: string;
  senderDid: string;
  senderHandle: string;
  senderBundle: E2EEKeyBundle;
  recipientDid: string;
  recipientHandle: string;
  recipientBundle: E2EEKeyBundle;
}): Promise<E2EEMessageEnvelope> {
  const plaintext = encoder.encode(input.plaintext);
  if (plaintext.length > E2EE_MAX_MESSAGE_PLAINTEXT_BYTES) {
    throw new Error('Encrypted message exceeds the maximum size');
  }
  const crypto = await ready();
  const contentKey = crypto.randombytes_buf(crypto.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
  const nonce = crypto.randombytes_buf(crypto.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const conversationParticipants = [input.senderDid, input.recipientDid].sort();
  const conversationId = `dm1_${toBase64Url(crypto.crypto_generichash(
    16,
    encoder.encode(JSON.stringify(conversationParticipants)),
    null,
  ))}`;
  const header = {
    protocol: E2EE_PROTOCOL,
    cipherSuite: E2EE_CIPHER_SUITE,
    messageId: uuidv4(),
    conversationId,
    senderDid: input.senderDid,
    senderHandle: input.senderHandle,
    recipientDid: input.recipientDid,
    recipientHandle: input.recipientHandle,
    createdAt: Date.now(),
    senderKeyId: input.senderBundle.keyId,
    senderKeyVersion: input.senderBundle.version,
    recipientKeyId: input.recipientBundle.keyId,
    recipientKeyVersion: input.recipientBundle.version,
  } as const;

  const recipients = new Map<string, E2EEKeyBundle>();
  recipients.set(input.senderDid, input.senderBundle);
  recipients.set(input.recipientDid, input.recipientBundle);
  let sealedPayload: Uint8Array | null = null;

  try {
    const authenticatedData = encoder.encode(messageAuthenticatedData(header));
    const ciphertext = crypto.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      authenticatedData,
      null,
      nonce,
      contentKey,
    );

    const transcriptHash = crypto.crypto_hash_sha256(authenticatedData);
    sealedPayload = concatBytes(contentKey, transcriptHash);
    const keyCommitment = crypto.crypto_generichash(
      32,
      concatBytes(authenticatedData, nonce, ciphertext),
      contentKey,
    );

    return {
      ...header,
      nonce: toBase64Url(nonce),
      ciphertext: toBase64Url(ciphertext),
      keyCommitment: toBase64Url(keyCommitment),
      keyEnvelopes: Array.from(recipients.entries()).map(([did, bundle]) => ({
        did,
        keyId: bundle.keyId,
        keyVersion: bundle.version,
        sealedKey: toBase64Url(
          crypto.crypto_box_seal(sealedPayload!, fromBase64Url(bundle.publicKey)),
        ),
      })),
    };
  } finally {
    crypto.memzero(plaintext);
    crypto.memzero(contentKey);
    if (sealedPayload) crypto.memzero(sealedPayload);
  }
}

export async function decryptE2EEMessage(
  envelope: E2EEMessageEnvelope,
  userDid: string,
  material: E2EEKeyMaterial,
): Promise<string> {
  const crypto = await ready();
  const wrappedKey = envelope.keyEnvelopes.find(
    (candidate) => candidate.did === userDid && candidate.keyId === material.keyId,
  );
  if (!wrappedKey) {
    throw new Error('Message was encrypted for a different encryption key');
  }

  const sealedPayload = crypto.crypto_box_seal_open(
    fromBase64Url(wrappedKey.sealedKey),
    fromBase64Url(material.publicKey),
    fromBase64Url(material.privateKey),
  );
  let contentKey: Uint8Array | null = null;

  try {
    if (sealedPayload.length !== 64) throw new Error('Encrypted message key payload is invalid');
    contentKey = sealedPayload.slice(0, 32);
    const expectedTranscriptHash = sealedPayload.slice(32);
    const authenticatedData = encoder.encode(messageAuthenticatedData(envelope));
    const transcriptHash = crypto.crypto_hash_sha256(authenticatedData);
    if (!crypto.memcmp(transcriptHash, expectedTranscriptHash)) {
      throw new Error('Encrypted message key was transplanted from another message');
    }
    const commitment = crypto.crypto_generichash(
      32,
      concatBytes(authenticatedData, fromBase64Url(envelope.nonce), fromBase64Url(envelope.ciphertext)),
      contentKey,
    );
    if (!crypto.memcmp(commitment, fromBase64Url(envelope.keyCommitment))) {
      throw new Error('Encrypted message key commitment is invalid');
    }
    const plaintext = crypto.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      fromBase64Url(envelope.ciphertext),
      authenticatedData,
      fromBase64Url(envelope.nonce),
      contentKey,
    );
    return decoder.decode(plaintext);
  } finally {
    if (contentKey) crypto.memzero(contentKey);
    crypto.memzero(sealedPayload);
  }
}
