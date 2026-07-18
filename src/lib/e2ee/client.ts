'use client';

import { canonicalize, createSignedAction, verifySignedActionSignature } from '@/lib/crypto/user-signing';
import { signingPublicKeyFromDid, verifyE2EEPublicBundle } from './bundle-proof';
import {
  decodeChatMessageContent,
  type ChatAttachment,
  type ChatReplyReference,
} from '@/lib/chat/message-content';
import {
  createE2EEVault,
  decryptE2EEMessage,
  generateE2EEKeyMaterial,
  openE2EEVault,
  prepareE2EEVaultUnlock,
  toBase64Url,
} from './client-crypto';
import { persistE2EEKeyMaterial, restoreE2EEKeyMaterial } from './local-key-store';
import {
  E2EE_KEY_BUNDLE_ACTION,
  E2EE_PROTOCOL,
  E2EE_VAULT_REWRAP_ACTION,
  e2eeMessageEnvelopeSchema,
  e2eePublicBundleResponseSchema,
  e2eeVaultRecordSchema,
  e2eeVaultStatusSchema,
  signedUserActionSchema,
  validateMessageBindings,
  type E2EEKeyMaterial,
  type E2EEPublicBundleResponse,
  type E2EEVaultStatus,
} from './protocol';

export class E2EEClientError extends Error {
  constructor(message: string, readonly code: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'E2EEClientError';
  }
}

async function responseError(response: Response, fallback: string): Promise<E2EEClientError> {
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  return new E2EEClientError(
    typeof body?.error === 'string' ? body.error : fallback,
    typeof body?.code === 'string' ? body.code : 'E2EE_REQUEST_FAILED',
    body || undefined,
  );
}

export async function fetchE2EEVaultStatus(expectedDid: string): Promise<E2EEVaultStatus> {
  const response = await fetch('/api/e2ee/vault', { cache: 'no-store' });
  if (!response.ok) throw await responseError(response, 'Encrypted message setup could not be loaded');
  const status = e2eeVaultStatusSchema.parse(await response.json());
  if (status.ownerDid !== expectedDid) {
    throw new E2EEClientError('The active account changed while encrypted messages were loading', 'E2EE_ACCOUNT_CHANGED');
  }
  return status;
}

export async function provisionE2EEAccount(input: {
  did: string;
  handle: string;
  password: string;
  replacesKeyId?: string;
  currentPassword?: string;
}): Promise<E2EEKeyMaterial> {
  const material = await generateE2EEKeyMaterial();
  let version = 1;
  if (input.replacesKeyId) {
    const status = await fetchE2EEVaultStatus(input.did);
    const previousKey = status.configured
      ? { keyId: status.keyId, keyVersion: status.keyVersion }
      : status.previousKey;
    if (!previousKey || previousKey.keyId !== input.replacesKeyId) {
      throw new E2EEClientError('The encryption key to replace changed', 'E2EE_KEY_CONFLICT');
    }
    version = previousKey.keyVersion + 1;
  }
  const recovery = await createE2EEVault(input.password, material, input.did, version);
  const recoveryCommitment = toBase64Url(new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalize(recovery)),
  )));
  const bundle = {
    protocol: E2EE_PROTOCOL,
    keyId: material.keyId,
    version,
    publicKey: material.publicKey,
    createdAt: Date.now(),
    recoveryCommitment,
    ...(input.replacesKeyId ? { replacesKeyId: input.replacesKeyId } : {}),
  } as const;
  const proof = await createSignedAction(
    E2EE_KEY_BUNDLE_ACTION,
    bundle,
    input.did,
    input.handle,
  );

  const response = await fetch('/api/e2ee/vault', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proof,
      recovery,
      ...(input.currentPassword ? { currentPassword: input.currentPassword } : {}),
    }),
  });
  if (!response.ok) throw await responseError(response, 'Encrypted messages were not set up');

  try {
    await persistE2EEKeyMaterial(input.did, material);
  } catch (error) {
    // IndexedDB can be unavailable in private/restricted browser contexts. The
    // key remains usable in memory; this device will simply ask for the account password again.
    console.warn('[E2EE] Could not remember this device:', error);
  }
  return material;
}

export async function unlockE2EEAccount(
  did: string,
  credential: string,
  status: E2EEVaultStatus,
): Promise<E2EEKeyMaterial> {
  if (!status.configured || !status.keyId || !status.keyVersion || !status.publicKey || !status.salt
    || !status.kdfAlgorithm || !status.kdfOpsLimit || !status.kdfMemLimit) {
    throw new E2EEClientError('Encrypted message recovery is incomplete', 'E2EE_VAULT_INVALID');
  }

  const prepared = await prepareE2EEVaultUnlock(credential, {
    salt: status.salt,
    kdfOpsLimit: status.kdfOpsLimit,
    kdfMemLimit: status.kdfMemLimit,
  }, status.recoveryMethod);
  try {
    const response = await fetch('/api/e2ee/vault/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerDid: did,
        keyId: status.keyId,
        keyVersion: status.keyVersion,
        pinVerifier: prepared.pinVerifier,
      }),
    });
    if (!response.ok) {
      throw await responseError(response, 'Encrypted messages could not be unlocked');
    }

    const body = await response.json();
    const vault = e2eeVaultRecordSchema.parse(body.vault);
    const material = await openE2EEVault(prepared, vault, body.serverShare);
    if (material.keyId !== status.keyId || material.publicKey !== status.publicKey) {
      throw new E2EEClientError('Recovered key does not match this account', 'E2EE_KEY_MISMATCH');
    }
    try {
      await persistE2EEKeyMaterial(did, material);
    } catch (error) {
      console.warn('[E2EE] Could not remember this device:', error);
    }
    return material;
  } finally {
    prepared.pinKey.fill(0);
  }
}

async function recoveryCommitment(recovery: Awaited<ReturnType<typeof createE2EEVault>>): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalize(recovery)),
  )));
}

export async function rewrapE2EEAccount(input: {
  did: string;
  handle: string;
  material: E2EEKeyMaterial;
  keyVersion: number;
  password: string;
  currentPassword: string;
}): Promise<void> {
  const recovery = await createE2EEVault(
    input.password,
    input.material,
    input.did,
    input.keyVersion,
  );
  const proof = await createSignedAction(E2EE_VAULT_REWRAP_ACTION, {
    keyId: input.material.keyId,
    keyVersion: input.keyVersion,
    recoveryCommitment: await recoveryCommitment(recovery),
  }, input.did, input.handle);
  const response = await fetch('/api/e2ee/vault', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proof, recovery, currentPassword: input.currentPassword }),
  });
  if (!response.ok) throw await responseError(response, 'Encrypted message recovery could not be updated');
}

export async function migrateLegacyE2EEAccount(input: {
  did: string;
  handle: string;
  status: Extract<E2EEVaultStatus, { configured: true }>;
  password: string;
  legacyPin?: string;
  material?: E2EEKeyMaterial;
}): Promise<E2EEKeyMaterial> {
  const material = input.material ?? await unlockE2EEAccount(
    input.did,
    input.legacyPin || '',
    input.status,
  );
  await rewrapE2EEAccount({
    did: input.did,
    handle: input.handle,
    material,
    keyVersion: input.status.keyVersion,
    password: input.password,
    currentPassword: input.password,
  });
  return material;
}

export async function prepareE2EEPasswordChange(input: {
  did: string;
  currentPassword: string;
  newPassword: string;
}): Promise<Awaited<ReturnType<typeof createE2EEVault>> | undefined> {
  const status = await fetchE2EEVaultStatus(input.did);
  if (!status.configured || status.recoveryMethod !== 'password') return undefined;
  const local = await restoreE2EEKeyMaterial(input.did);
  const material = local?.keyId === status.keyId && local.publicKey === status.publicKey
    ? local
    : await unlockE2EEAccount(input.did, input.currentPassword, status);
  return createE2EEVault(input.newPassword, material, input.did, status.keyVersion);
}

export async function resolveE2EEPublicBundle(
  did: string,
  handle: string,
): Promise<E2EEPublicBundleResponse> {
  const response = await fetch(
    `/api/e2ee/keys/resolve?did=${encodeURIComponent(did)}&handle=${encodeURIComponent(handle)}`,
    { cache: 'no-store' },
  );
  if (!response.ok) throw await responseError(response, 'Recipient encryption key could not be verified');
  const result = e2eePublicBundleResponseSchema.parse(await response.json());
  if (!await verifyE2EEPublicBundle(result, did)) {
    throw new E2EEClientError('Recipient encryption key proof is invalid', 'E2EE_KEY_PROOF_INVALID');
  }
  return result;
}

export interface StoredChatMessage {
  protocolVersion: number;
  content?: string | null;
  encryptedEnvelope?: unknown;
  signedAction?: unknown;
  senderPublicKey?: string | null;
}

export async function decryptStoredChatMessage(
  message: StoredChatMessage,
  userDid: string,
  material: E2EEKeyMaterial,
): Promise<{
  content: string;
  attachments: ChatAttachment[];
  replyTo: ChatReplyReference | null;
  legacy: boolean;
}> {
  if (message.protocolVersion === 0) {
    return {
      content: message.content || '[Empty legacy message]',
      attachments: [],
      replyTo: null,
      legacy: true,
    };
  }

  const envelope = e2eeMessageEnvelopeSchema.parse(message.encryptedEnvelope);
  const signedAction = signedUserActionSchema.parse(message.signedAction);
  validateMessageBindings(envelope, signedAction);
  if (canonicalize(signedAction.data) !== canonicalize(envelope)) {
    throw new E2EEClientError('Encrypted message envelope was altered', 'E2EE_MESSAGE_TAMPERED');
  }

  const signingPublicKey = signingPublicKeyFromDid(signedAction.did) || message.senderPublicKey;
  if (!signingPublicKey || !await verifySignedActionSignature(signedAction, signingPublicKey)) {
    throw new E2EEClientError('Encrypted message signature is invalid', 'E2EE_MESSAGE_SIGNATURE_INVALID');
  }
  const content = decodeChatMessageContent(await decryptE2EEMessage(envelope, userDid, material));
  return {
    content: content.text,
    attachments: content.attachments,
    replyTo: content.replyTo || null,
    legacy: false,
  };
}
