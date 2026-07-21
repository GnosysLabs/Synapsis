import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireSignedAction: vi.fn(),
  createFederationActionContext: vi.fn(),
  createSignedPayload: vi.fn(),
  isNodeBlocked: vi.fn(),
  safeFederationRequest: vi.fn(),
  usersFindFirst: vi.fn(),
  keyBundleFindFirst: vi.fn(),
  keyVaultFindFirst: vi.fn(),
  remoteKeyFindFirst: vi.fn(),
  handleRegistryFindFirst: vi.fn(),
  blockFindFirst: vi.fn(),
  followFindFirst: vi.fn(),
}));

vi.mock('@/lib/auth/verify-signature', () => {
  class SignedActionError extends Error {}
  return {
    requireSignedAction: mocks.requireSignedAction,
    SignedActionError,
  };
});

vi.mock('@/lib/swarm/federated-action', () => ({
  createFederationActionContext: mocks.createFederationActionContext,
}));

vi.mock('@/lib/swarm/signature', () => ({
  createSignedPayload: mocks.createSignedPayload,
}));

vi.mock('@/lib/swarm/node-blocklist', () => ({
  isNodeBlocked: mocks.isNodeBlocked,
  normalizeNodeDomain: (value: string) => value.trim().toLowerCase(),
}));

vi.mock('@/lib/swarm/safe-federation-http', () => ({
  safeFederationRequest: mocks.safeFederationRequest,
}));

vi.mock('@/lib/push/messages', () => ({
  enqueueMessagePushDeliveries: vi.fn(),
}));

vi.mock('@/db', () => ({
  chatConversations: {
    id: 'chatConversations.id',
    participant1Id: 'chatConversations.participant1Id',
    participant2Handle: 'chatConversations.participant2Handle',
  },
  chatMessages: { id: 'chatMessages.id' },
  e2eeMessageReceipts: { id: 'e2eeMessageReceipts.id' },
  db: {
    query: {
      users: { findFirst: mocks.usersFindFirst },
      e2eeKeyBundles: { findFirst: mocks.keyBundleFindFirst },
      e2eeKeyVaults: { findFirst: mocks.keyVaultFindFirst },
      e2eeRemoteKeyBundles: { findFirst: mocks.remoteKeyFindFirst },
      handleRegistry: { findFirst: mocks.handleRegistryFindFirst },
      blocks: { findFirst: mocks.blockFindFirst },
      follows: { findFirst: mocks.followFindFirst },
    },
    transaction: vi.fn(),
  },
}));

import { POST } from './route';

const senderDid = 'did:key:local-sender';
const recipientDid = 'did:key:verified-remote-recipient';
const senderKeyId = 'k1_sender_key_01';
const recipientKeyId = 'k1_recipient_key_01';

function signedMessage() {
  const now = Date.now();
  const envelope = {
    protocol: 'synapsis-e2ee-v1',
    cipherSuite: 'x25519+xchacha20poly1305+blake2b-v1',
    messageId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
    conversationId: 'dm1_conversation_01',
    senderDid,
    senderHandle: 'alice@local.social',
    recipientDid,
    recipientHandle: 'bob@remote.social',
    createdAt: now,
    senderKeyId,
    senderKeyVersion: 1,
    recipientKeyId,
    recipientKeyVersion: 1,
    nonce: Buffer.alloc(24, 1).toString('base64url'),
    ciphertext: Buffer.alloc(17, 2).toString('base64url'),
    keyCommitment: Buffer.alloc(32, 3).toString('base64url'),
    keyEnvelopes: [
      {
        did: senderDid,
        keyId: senderKeyId,
        keyVersion: 1,
        sealedKey: Buffer.alloc(112, 4).toString('base64url'),
      },
      {
        did: recipientDid,
        keyId: recipientKeyId,
        keyVersion: 1,
        sealedKey: Buffer.alloc(112, 5).toString('base64url'),
      },
    ],
  };
  return {
    action: 'chat_e2ee',
    data: envelope,
    did: senderDid,
    handle: 'alice@local.social',
    ts: now,
    nonce: 'sender_action_nonce',
    sig: 'sender_action_signature',
  };
}

function request() {
  return new NextRequest('https://local.social/api/chat/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signedMessage()),
  });
}

describe('outbound federated E2EE recipient identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_NODE_DOMAIN = 'local.social';
    mocks.requireSignedAction.mockResolvedValue({
      id: 'sender-id',
      did: senderDid,
      handle: 'alice@local.social',
      username: 'alice',
      homeDomain: 'local.social',
      isLocalAccount: true,
      displayName: 'Alice',
      avatarUrl: null,
    });
    mocks.usersFindFirst.mockResolvedValue(null);
    mocks.keyBundleFindFirst.mockResolvedValue({
      keyId: senderKeyId,
      keyVersion: 1,
      publicKey: 'sender-encryption-public-key',
    });
    mocks.keyVaultFindFirst.mockResolvedValue({
      ownerDid: senderDid,
      keyId: senderKeyId,
      keyVersion: 1,
      publicKey: 'sender-encryption-public-key',
    });
    mocks.remoteKeyFindFirst.mockResolvedValue({
      did: recipientDid,
      handle: 'bob@remote.social',
      keyId: recipientKeyId,
      keyVersion: 1,
    });
    mocks.blockFindFirst.mockResolvedValue(null);
    mocks.followFindFirst.mockResolvedValue(null);
    mocks.isNodeBlocked.mockResolvedValue(false);
    mocks.createFederationActionContext.mockReturnValue({
      protocol: 'synapsis-federation-action-v3',
      sourceDomain: 'local.social',
      destinationDomain: 'remote.social',
      method: 'POST',
      path: '/api/chat/receive',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    mocks.createSignedPayload.mockResolvedValue({ payload: '{}', signature: 'node-signature' });
    mocks.safeFederationRequest.mockResolvedValue({
      status: 503,
      json: () => ({ error: 'test delivery stop' }),
    });
  });

  it('fails closed when no verified handle pin exists', async () => {
    mocks.handleRegistryFindFirst.mockResolvedValue(null);

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'E2EE_IDENTITY_KEY_CHANGED',
    });
    expect(mocks.safeFederationRequest).not.toHaveBeenCalled();
  });

  it('rejects a cached attacker DID that differs from the verified handle pin', async () => {
    mocks.handleRegistryFindFirst.mockResolvedValue({
      handle: 'bob@remote.social',
      did: 'did:key:established-bob',
      nodeDomain: 'remote.social',
      identityVerified: true,
    });

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'E2EE_IDENTITY_KEY_CHANGED',
    });
    expect(mocks.safeFederationRequest).not.toHaveBeenCalled();
  });

  it('does not treat an unverified directory hint as recipient authority', async () => {
    mocks.handleRegistryFindFirst.mockResolvedValue({
      handle: 'bob@remote.social',
      did: recipientDid,
      nodeDomain: 'remote.social',
      identityVerified: false,
    });

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(mocks.safeFederationRequest).not.toHaveBeenCalled();
  });

  it('rejects a verified DID pinned by a different authoritative node', async () => {
    mocks.handleRegistryFindFirst.mockResolvedValue({
      handle: 'bob@remote.social',
      did: recipientDid,
      nodeDomain: 'other.social',
      identityVerified: true,
    });

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(mocks.safeFederationRequest).not.toHaveBeenCalled();
  });

  it('allows delivery to proceed only for an exact verified handle, DID, and domain match', async () => {
    mocks.handleRegistryFindFirst.mockResolvedValue({
      handle: 'bob@remote.social',
      did: recipientDid,
      nodeDomain: 'remote.social',
      identityVerified: true,
    });

    const response = await POST(request());

    expect(response.status).toBe(502);
    expect(mocks.safeFederationRequest).toHaveBeenCalledOnce();
  });
});
