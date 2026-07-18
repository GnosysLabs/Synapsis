import { z } from 'zod';

import { canonicalize } from '@/lib/crypto/user-signing';

export const E2EE_PROTOCOL = 'synapsis-e2ee-v1' as const;
export const E2EE_PROTOCOL_VERSION = 1;
export const E2EE_CIPHER_SUITE = 'x25519+xchacha20poly1305+blake2b-v1' as const;
export const E2EE_KEY_BUNDLE_ACTION = 'e2ee_key_bundle' as const;
export const E2EE_CHAT_ACTION = 'chat_e2ee' as const;
export const E2EE_VAULT_REWRAP_ACTION = 'e2ee_vault_rewrap' as const;
export const E2EE_RECOVERY_PASSWORD_MIN_LENGTH = 8;
export const E2EE_RECOVERY_PASSWORD_MAX_LENGTH = 256;
export const E2EE_MAX_UNLOCK_ATTEMPTS = 10;
export const E2EE_LOCKOUT_MS = 60 * 60 * 1000;
export const E2EE_MAX_MESSAGE_PLAINTEXT_BYTES = 32_000;
export const E2EE_MAX_MESSAGE_CIPHERTEXT_BYTES = E2EE_MAX_MESSAGE_PLAINTEXT_BYTES + 16;
export const E2EE_MAX_MESSAGE_CIPHERTEXT_BASE64_LENGTH = 43_000;

export const E2EE_KDF = {
  algorithm: 'argon2id13' as const,
  opsLimit: 2,
  memLimit: 64 * 1024 * 1024,
};

const base64UrlSchema = z.string().min(1).max(E2EE_MAX_MESSAGE_CIPHERTEXT_BASE64_LENGTH).regex(/^[A-Za-z0-9_-]+$/);
const didSchema = z.string().min(8).max(2_048).regex(/^did:/);
const handleSchema = z.string().min(1).max(320);
const keyIdSchema = z.string().min(12).max(96).regex(/^k1_[A-Za-z0-9_-]+$/);

export const e2eeKeyBundleSchema = z.strictObject({
  protocol: z.literal(E2EE_PROTOCOL),
  keyId: keyIdSchema,
  version: z.number().int().positive().max(1_000_000),
  publicKey: base64UrlSchema.max(64),
  createdAt: z.number().int().positive(),
  recoveryCommitment: base64UrlSchema.max(64),
  replacesKeyId: keyIdSchema.optional(),
}).superRefine((bundle, context) => {
  if (bundle.version === 1 && bundle.replacesKeyId) {
    context.addIssue({ code: 'custom', path: ['replacesKeyId'], message: 'Initial encryption keys cannot replace another key' });
  }
  if (bundle.version > 1 && !bundle.replacesKeyId) {
    context.addIssue({ code: 'custom', path: ['replacesKeyId'], message: 'Rotated encryption keys must name their predecessor' });
  }
});

export type E2EEKeyBundle = z.infer<typeof e2eeKeyBundleSchema>;

export const signedUserActionSchema = z.strictObject({
  action: z.string().min(1).max(64),
  data: z.unknown(),
  did: didSchema,
  handle: handleSchema,
  ts: z.number().int().positive(),
  nonce: base64UrlSchema.max(128),
  sig: base64UrlSchema.max(256),
});

export type SignedUserAction = z.infer<typeof signedUserActionSchema>;

export const e2eeKeyEnvelopeSchema = z.strictObject({
  did: didSchema,
  keyId: keyIdSchema,
  keyVersion: z.number().int().positive().max(1_000_000),
  sealedKey: base64UrlSchema.max(256),
});

export const e2eeMessageEnvelopeSchema = z.strictObject({
  protocol: z.literal(E2EE_PROTOCOL),
  cipherSuite: z.literal(E2EE_CIPHER_SUITE),
  messageId: z.string().uuid(),
  conversationId: z.string().min(12).max(96).regex(/^dm1_[A-Za-z0-9_-]+$/),
  senderDid: didSchema,
  senderHandle: handleSchema,
  recipientDid: didSchema,
  recipientHandle: handleSchema,
  createdAt: z.number().int().positive(),
  senderKeyId: keyIdSchema,
  senderKeyVersion: z.number().int().positive().max(1_000_000),
  recipientKeyId: keyIdSchema,
  recipientKeyVersion: z.number().int().positive().max(1_000_000),
  nonce: base64UrlSchema.max(64),
  ciphertext: base64UrlSchema.max(E2EE_MAX_MESSAGE_CIPHERTEXT_BASE64_LENGTH),
  keyCommitment: base64UrlSchema.max(64),
  keyEnvelopes: z.array(e2eeKeyEnvelopeSchema).min(1).max(2),
});

export type E2EEMessageEnvelope = z.infer<typeof e2eeMessageEnvelopeSchema>;
export type E2EEKeyEnvelope = z.infer<typeof e2eeKeyEnvelopeSchema>;

export const e2eeVaultRecordSchema = z.strictObject({
  protocol: z.literal(E2EE_PROTOCOL),
  ownerDid: didSchema,
  keyId: keyIdSchema,
  keyVersion: z.number().int().positive().max(1_000_000),
  publicKey: base64UrlSchema.max(64),
  ciphertext: base64UrlSchema.max(4_096),
  nonce: base64UrlSchema.max(64),
  salt: base64UrlSchema.max(64),
  kdfAlgorithm: z.literal(E2EE_KDF.algorithm),
  kdfOpsLimit: z.number().int().min(1).max(10),
  kdfMemLimit: z.number().int().min(8 * 1024 * 1024).max(256 * 1024 * 1024),
});

export type E2EEVaultRecord = z.infer<typeof e2eeVaultRecordSchema>;

export const e2eeVaultSetupSchema = z.strictObject({
  vault: e2eeVaultRecordSchema,
  serverShare: base64UrlSchema.max(64),
  pinVerifier: base64UrlSchema.max(64),
});

export type E2EEVaultSetup = z.infer<typeof e2eeVaultSetupSchema>;

export interface E2EEPublicBundleResponse {
  bundle: E2EEKeyBundle;
  proof: SignedUserAction;
  signingPublicKey: string;
}

export const e2eePublicBundleResponseSchema = z.strictObject({
  bundle: e2eeKeyBundleSchema,
  proof: signedUserActionSchema,
  signingPublicKey: z.string().min(1).max(8_192),
});

export interface E2EEKeyMaterial {
  keyId: string;
  publicKey: string;
  privateKey: string;
}

export const e2eeVaultStatusSchema = z.discriminatedUnion('configured', [
  z.strictObject({
    ownerDid: didSchema,
    configured: z.literal(false),
    previousKey: z.strictObject({
      keyId: keyIdSchema,
      keyVersion: z.number().int().positive().max(1_000_000),
    }).optional(),
  }),
  z.strictObject({
    ownerDid: didSchema,
    configured: z.literal(true),
    keyId: keyIdSchema,
    keyVersion: z.number().int().positive().max(1_000_000),
    publicKey: base64UrlSchema.max(64),
    salt: base64UrlSchema.max(64),
    kdfAlgorithm: z.literal(E2EE_KDF.algorithm),
    kdfOpsLimit: z.number().int().min(1).max(10),
    kdfMemLimit: z.number().int().min(8 * 1024 * 1024).max(256 * 1024 * 1024),
    recoveryMethod: z.enum(['password', 'legacy_pin']),
    failedAttempts: z.number().int().min(0).max(E2EE_MAX_UNLOCK_ATTEMPTS),
    attemptsRemaining: z.number().int().min(0).max(E2EE_MAX_UNLOCK_ATTEMPTS),
    lockedUntil: z.string().datetime().nullable(),
  }),
]);

export type E2EEVaultStatus = z.infer<typeof e2eeVaultStatusSchema>;

export function messageAuthenticatedData(
  envelope: Pick<
    E2EEMessageEnvelope,
    | 'protocol'
    | 'cipherSuite'
    | 'messageId'
    | 'conversationId'
    | 'senderDid'
    | 'senderHandle'
    | 'recipientDid'
    | 'recipientHandle'
    | 'createdAt'
    | 'senderKeyId'
    | 'senderKeyVersion'
    | 'recipientKeyId'
    | 'recipientKeyVersion'
  >,
): string {
  return canonicalize({
    protocol: envelope.protocol,
    cipherSuite: envelope.cipherSuite,
    messageId: envelope.messageId,
    conversationId: envelope.conversationId,
    senderDid: envelope.senderDid,
    senderHandle: envelope.senderHandle,
    recipientDid: envelope.recipientDid,
    recipientHandle: envelope.recipientHandle,
    createdAt: envelope.createdAt,
    senderKeyId: envelope.senderKeyId,
    senderKeyVersion: envelope.senderKeyVersion,
    recipientKeyId: envelope.recipientKeyId,
    recipientKeyVersion: envelope.recipientKeyVersion,
  });
}

export function vaultAuthenticatedData(
  record: Pick<
    E2EEVaultRecord,
    'protocol' | 'ownerDid' | 'keyId' | 'keyVersion' | 'publicKey' | 'salt' | 'kdfAlgorithm' | 'kdfOpsLimit' | 'kdfMemLimit'
  >,
): string {
  return canonicalize({
    protocol: record.protocol,
    ownerDid: record.ownerDid,
    keyId: record.keyId,
    keyVersion: record.keyVersion,
    publicKey: record.publicKey,
    salt: record.salt,
    kdfAlgorithm: record.kdfAlgorithm,
    kdfOpsLimit: record.kdfOpsLimit,
    kdfMemLimit: record.kdfMemLimit,
  });
}

export function validateMessageBindings(
  envelope: E2EEMessageEnvelope,
  signedAction: Pick<SignedUserAction, 'action' | 'did' | 'handle' | 'ts'>,
): void {
  if (signedAction.action !== E2EE_CHAT_ACTION) {
    throw new Error('Encrypted message action is invalid');
  }
  if (envelope.senderDid !== signedAction.did || envelope.senderHandle !== signedAction.handle) {
    throw new Error('Encrypted message sender does not match its signature');
  }
  // A sender may re-sign the same prepared envelope after an ambiguous network
  // failure so its stable messageId remains idempotent. Old envelope timestamps
  // are therefore valid; only future-dated envelopes are rejected.
  if (envelope.createdAt > signedAction.ts + 5 * 60 * 1000) {
    throw new Error('Encrypted message timestamp is too far in the future');
  }

  const uniqueRecipients = new Set(envelope.keyEnvelopes.map((item) => item.did));
  if (uniqueRecipients.size !== envelope.keyEnvelopes.length) {
    throw new Error('Encrypted message contains duplicate key envelopes');
  }

  const senderEnvelope = envelope.keyEnvelopes.find((item) => item.did === envelope.senderDid);
  const recipientEnvelope = envelope.keyEnvelopes.find((item) => item.did === envelope.recipientDid);
  if (!senderEnvelope || senderEnvelope.keyId !== envelope.senderKeyId
    || senderEnvelope.keyVersion !== envelope.senderKeyVersion) {
    throw new Error('Encrypted message is missing the sender key envelope');
  }
  if (!recipientEnvelope || recipientEnvelope.keyId !== envelope.recipientKeyId
    || recipientEnvelope.keyVersion !== envelope.recipientKeyVersion) {
    throw new Error('Encrypted message is missing the recipient key envelope');
  }
}

export function validateRecoveryPassword(password: string): void {
  if (password.length < E2EE_RECOVERY_PASSWORD_MIN_LENGTH
    || password.length > E2EE_RECOVERY_PASSWORD_MAX_LENGTH) {
    throw new Error(`Password must contain ${E2EE_RECOVERY_PASSWORD_MIN_LENGTH}-${E2EE_RECOVERY_PASSWORD_MAX_LENGTH} characters`);
  }
}

export function validateLegacyPin(pin: string): void {
  if (!/^\d{6,12}$/.test(pin)) {
    throw new Error('PIN must contain 6-12 digits');
  }
}
