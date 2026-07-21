import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyFederatedUserAction: vi.fn(),
  pinVerifiedFederatedActorIdentity: vi.fn(),
  signingPublicKeyFromDid: vi.fn(),
  isNodeBlocked: vi.fn(),
  usersFindFirst: vi.fn(),
  keyBundleFindFirst: vi.fn(),
  keyVaultFindFirst: vi.fn(),
  remoteFollowFindFirst: vi.fn(),
  blockFindFirst: vi.fn(),
  receiptInsertResult: vi.fn(),
  conversationLookup: vi.fn(),
  conversationInsertResult: vi.fn(),
  quotaConsumeResult: vi.fn(),
  receiptValues: vi.fn(),
  conversationValues: vi.fn(),
  quotaValues: vi.fn(),
  messageValues: vi.fn(),
  enqueueMessagePushDeliveries: vi.fn(),
  transaction: vi.fn(),
  transactionEvents: [] as string[],
}));

vi.mock('@/lib/swarm/federated-action', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/swarm/federated-action')>();
  return {
    ...actual,
    verifyFederatedUserAction: mocks.verifyFederatedUserAction,
    pinVerifiedFederatedActorIdentity: mocks.pinVerifiedFederatedActorIdentity,
  };
});

vi.mock('@/lib/e2ee/bundle-proof', () => ({
  signingPublicKeyFromDid: mocks.signingPublicKeyFromDid,
}));

vi.mock('@/lib/swarm/node-blocklist', () => ({
  isNodeBlocked: mocks.isNodeBlocked,
  normalizeNodeDomain: (value: string) => value.trim().toLowerCase(),
}));

vi.mock('@/lib/push/messages', () => ({
  enqueueMessagePushDeliveries: mocks.enqueueMessagePushDeliveries,
}));

vi.mock('@/lib/swarm/safe-federation-http', () => ({
  E2EE_FEDERATION_MAX_REQUEST_BYTES: 128 * 1024,
}));

vi.mock('@/db', () => {
  const handleRegistry = {
    handle: 'handleRegistry.handle',
    did: 'handleRegistry.did',
    nodeDomain: 'handleRegistry.nodeDomain',
  };
  const e2eeMessageReceipts = { id: 'e2eeMessageReceipts.id' };
  const chatConversationIngressQuotaBuckets = {
    recipientUserId: 'chatConversationIngressQuotaBuckets.recipientUserId',
    sourceDomain: 'chatConversationIngressQuotaBuckets.sourceDomain',
    bucketStartMs: 'chatConversationIngressQuotaBuckets.bucketStartMs',
    conversationCount: 'chatConversationIngressQuotaBuckets.conversationCount',
    messageCount: 'chatConversationIngressQuotaBuckets.messageCount',
    ciphertextBytes: 'chatConversationIngressQuotaBuckets.ciphertextBytes',
  };
  const chatConversations = {
    id: 'chatConversations.id',
    participant1Id: 'chatConversations.participant1Id',
    participant2Handle: 'chatConversations.participant2Handle',
  };
  const chatMessages = { id: 'chatMessages.id' };

  const tx = {
    insert: vi.fn((table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        if (table === e2eeMessageReceipts) {
          mocks.transactionEvents.push('receipt');
          mocks.receiptValues(values);
          return {
            onConflictDoNothing: () => ({
              returning: () => mocks.receiptInsertResult(),
            }),
          };
        }
        if (table === chatConversations) {
          mocks.transactionEvents.push('conversation');
          mocks.conversationValues(values);
          return {
            onConflictDoNothing: () => ({
              returning: () => mocks.conversationInsertResult(),
            }),
          };
        }
        if (table === chatConversationIngressQuotaBuckets) {
          mocks.transactionEvents.push('quota');
          mocks.quotaValues(values);
          return {
            onConflictDoUpdate: () => ({
              returning: () => mocks.quotaConsumeResult(),
            }),
          };
        }

        mocks.transactionEvents.push('message');
        mocks.messageValues(values);
        return {
          returning: async () => [{ id: 'message-row-id' }],
        };
      },
    })),
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: () => mocks.conversationLookup(),
        }),
      }),
    })),
    update: vi.fn(() => ({
      set: () => ({ where: async () => undefined }),
    })),
  };

  mocks.transaction.mockImplementation(async (callback: (value: typeof tx) => unknown) => callback(tx));

  return {
    handleRegistry,
    e2eeMessageReceipts,
    chatConversationIngressQuotaBuckets,
    chatConversations,
    chatMessages,
    db: {
      query: {
        users: { findFirst: mocks.usersFindFirst },
        e2eeKeyBundles: { findFirst: mocks.keyBundleFindFirst },
        e2eeKeyVaults: { findFirst: mocks.keyVaultFindFirst },
        remoteFollows: { findFirst: mocks.remoteFollowFindFirst },
        blocks: { findFirst: mocks.blockFindFirst },
      },
      transaction: mocks.transaction,
    },
  };
});

import { FederatedIdentityContinuityError } from '@/lib/swarm/federated-action';
import { POST } from './route';

const senderDid = 'did:key:sender-self-certifying';
const recipientDid = 'did:key:recipient-self-certifying';
const messageId = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const senderKeyId = 'k1_sender_key_01';
const recipientKeyId = 'k1_recipient_key_01';

function encryptedEnvelope(recipientHandle = 'bob@local.social') {
  // Historical v2 envelopes keep their exact bare signed sender handle.
  return {
    protocol: 'synapsis-e2ee-v1',
    cipherSuite: 'x25519+xchacha20poly1305+blake2b-v1',
    messageId,
    conversationId: 'dm1_conversation_01',
    senderDid,
    senderHandle: 'alice',
    recipientDid,
    recipientHandle,
    createdAt: Date.now(),
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
  } as const;
}

function payload(recipientHandle = 'bob@local.social') {
  const now = Date.now();
  const envelope = encryptedEnvelope(recipientHandle);
  return {
    federation: {
      protocol: 'synapsis-federation-action-v2',
      sourceDomain: 'remote.social',
      destinationDomain: 'local.social',
      method: 'POST',
      path: '/api/chat/receive',
      issuedAt: now,
      expiresAt: now + 5 * 60 * 1_000,
    },
    userAction: {
      action: 'chat_e2ee',
      data: envelope,
      did: senderDid,
      handle: 'alice',
      ts: now,
      nonce: 'sender_action_nonce',
      sig: 'sender_action_signature',
    },
    fullSenderHandle: 'alice@remote.social',
    deliveryId: `${messageId}:local.social`,
  } as const;
}

function request(body: object = payload()) {
  return new Request('https://local.social/api/chat/receive', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Swarm-Source-Domain': 'remote.social',
      'X-Swarm-Signature': 'node-signature',
    },
    body: JSON.stringify(body),
  });
}

describe('federated encrypted-message receiver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transactionEvents.length = 0;
    process.env.NEXT_PUBLIC_NODE_DOMAIN = 'local.social';
    mocks.isNodeBlocked.mockResolvedValue(false);
    mocks.signingPublicKeyFromDid.mockImplementation((did: string) => (
      did === senderDid ? 'sender-signing-public-key' : null
    ));
    mocks.verifyFederatedUserAction.mockImplementation(async ({ payload: verifiedPayload }) => ({
      ok: true,
      actorHandle: 'alice@remote.social',
      actorUsername: 'alice',
      sourceDomain: 'remote.social',
      destinationDomain: 'local.social',
      userAction: verifiedPayload.userAction,
      replayId: 'verified-chat-replay-id',
    }));
    mocks.pinVerifiedFederatedActorIdentity.mockImplementation(async () => {
      mocks.transactionEvents.push('identity');
      return {
        sourceDomain: 'remote.social',
        actorHandle: 'alice@remote.social',
        qualifiedHandle: 'alice@remote.social',
        did: senderDid,
      };
    });
    mocks.usersFindFirst.mockImplementation(async ({ where }) => {
      if (where.did === recipientDid) {
        return {
          id: 'recipient-id',
          did: recipientDid,
          handle: 'bob@local.social',
          username: 'bob',
          homeDomain: 'local.social',
          isLocalAccount: true,
          dmPrivacy: 'all',
        };
      }
      return null;
    });
    mocks.keyBundleFindFirst.mockResolvedValue({
      keyId: recipientKeyId,
      keyVersion: 1,
      publicKey: 'recipient-encryption-public-key',
    });
    mocks.keyVaultFindFirst.mockResolvedValue({
      ownerDid: recipientDid,
      keyId: recipientKeyId,
      keyVersion: 1,
      publicKey: 'recipient-encryption-public-key',
    });
    mocks.remoteFollowFindFirst.mockResolvedValue(null);
    mocks.blockFindFirst.mockResolvedValue(null);
    mocks.receiptInsertResult.mockResolvedValue([{ id: 'receipt-id' }]);
    mocks.conversationLookup.mockResolvedValue([]);
    mocks.conversationInsertResult.mockResolvedValue([{
      id: 'conversation-id',
      lastMessageAt: null,
      e2eeActivatedAt: null,
    }]);
    mocks.quotaConsumeResult.mockResolvedValue([{ messageCount: 1 }]);
    mocks.enqueueMessagePushDeliveries.mockResolvedValue(undefined);
  });

  it('requires the exact node route and self-certifying user proof before storing opaque ciphertext', async () => {
    const body = payload();
    const response = await POST(request(body) as never);

    expect(response.status).toBe(200);
    expect(mocks.verifyFederatedUserAction).toHaveBeenCalledWith(expect.objectContaining({
      payload: body,
      nodeSignature: 'node-signature',
      sourceDomain: 'remote.social',
      expectedMethod: 'POST',
      expectedPath: '/api/chat/receive',
      expectedAction: 'chat_e2ee',
      actorHandle: 'alice@remote.social',
      replayBinding: {
        deliveryId: `${messageId}:local.social`,
        fullSenderHandle: 'alice@remote.social',
      },
    }));
    expect(mocks.transactionEvents).toEqual(['identity', 'receipt', 'conversation', 'quota', 'message']);
    expect(mocks.pinVerifiedFederatedActorIdentity).toHaveBeenCalledWith({
      sourceDomain: 'remote.social',
      actorHandle: 'alice@remote.social',
      did: senderDid,
    }, expect.anything());
    expect(mocks.messageValues).toHaveBeenCalledWith(expect.objectContaining({
      senderHandle: 'alice@remote.social',
      senderDisplayName: 'alice',
      senderAvatarUrl: null,
      senderNodeDomain: 'remote.social',
      senderDid,
      content: null,
      clientMessageId: messageId,
      encryptedEnvelope: JSON.stringify(body.userAction.data),
      e2eeSignature: body.userAction.sig,
    }));
    expect(mocks.messageValues.mock.calls[0][0]).not.toHaveProperty('attachments');
    expect(mocks.enqueueMessagePushDeliveries).toHaveBeenCalledWith(
      expect.anything(),
      'recipient-id',
      'message-row-id',
    );
  });

  it('rejects a new conversation when the durable recipient/source daily budget is exhausted', async () => {
    mocks.quotaConsumeResult.mockResolvedValue([]);

    const response = await POST(request() as never);

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      code: 'E2EE_DAILY_INGRESS_LIMIT',
    });
    expect(response.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect(mocks.quotaValues).toHaveBeenCalledWith(expect.objectContaining({
      recipientUserId: 'recipient-id',
      sourceDomain: 'remote.social',
      conversationCount: 1,
      messageCount: 1,
      ciphertextBytes: 17,
    }));
    expect(mocks.messageValues).not.toHaveBeenCalled();
    expect(mocks.enqueueMessagePushDeliveries).not.toHaveBeenCalled();
  });

  it('charges message and byte budgets but not first-contact budget for an established conversation', async () => {
    mocks.conversationLookup.mockResolvedValue([{
      id: 'existing-conversation-id',
      lastMessageAt: new Date(0),
      e2eeActivatedAt: new Date(0),
    }]);

    const response = await POST(request() as never);

    expect(response.status).toBe(200);
    expect(mocks.quotaValues).toHaveBeenCalledWith(expect.objectContaining({
      recipientUserId: 'recipient-id',
      sourceDomain: 'remote.social',
      conversationCount: 0,
      messageCount: 1,
      ciphertextBytes: 17,
    }));
    expect(mocks.messageValues).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'existing-conversation-id',
    }));
  });

  it('rejects storage growth in an established conversation after its daily ingress budget is exhausted', async () => {
    mocks.conversationLookup.mockResolvedValue([{
      id: 'existing-conversation-id',
      lastMessageAt: new Date(0),
      e2eeActivatedAt: new Date(0),
    }]);
    mocks.quotaConsumeResult.mockResolvedValue([]);

    const response = await POST(request() as never);

    expect(response.status).toBe(429);
    expect(mocks.conversationValues).not.toHaveBeenCalled();
    expect(mocks.messageValues).not.toHaveBeenCalled();
    expect(mocks.enqueueMessagePushDeliveries).not.toHaveBeenCalled();
  });

  it('rejects a failed node or user proof before resolving the recipient', async () => {
    mocks.verifyFederatedUserAction.mockResolvedValue({
      ok: false,
      error: 'Invalid user signature',
      status: 403,
    });

    const response = await POST(request() as never);

    expect(response.status).toBe(403);
    expect(mocks.usersFindFirst).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('fails closed if a verifier ever returns a non-self-certifying sender DID', async () => {
    const body = payload();
    const legacyDid = 'did:synapsis:legacy-sender';
    const legacyEnvelope = {
      ...body.userAction.data,
      senderDid: legacyDid,
      keyEnvelopes: body.userAction.data.keyEnvelopes.map((keyEnvelope, index) => (
        index === 0 ? { ...keyEnvelope, did: legacyDid } : keyEnvelope
      )),
    };
    const legacyBody = {
      ...body,
      userAction: {
        ...body.userAction,
        did: legacyDid,
        data: legacyEnvelope,
      },
    };

    const response = await POST(request(legacyBody) as never);

    expect(response.status).toBe(403);
    expect(mocks.pinVerifiedFederatedActorIdentity).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('rejects a user-signed bare recipient handle that does not bind the destination node', async () => {
    const response = await POST(request(payload('bob')) as never);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Recipient identity mismatch' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('rejects transport-supplied sender metadata or attachment fields', async () => {
    const response = await POST(request({
      ...payload(),
      senderDisplayName: 'Node-controlled name',
      senderAvatarUrl: 'https://remote.social/attacker-avatar.jpg',
      attachments: [{ url: 'https://remote.social/attacker-file' }],
    }) as never);

    expect(response.status).toBe(426);
    expect(mocks.verifyFederatedUserAction).not.toHaveBeenCalled();
    expect(mocks.usersFindFirst).not.toHaveBeenCalled();
  });

  it('does not promote node-populated profile presentation metadata into the message', async () => {
    const cachedSender = {
      id: 'cached-sender-id',
      did: senderDid,
      handle: 'alice@remote.social',
      publicKey: null,
      displayName: 'Node-controlled cached name',
      avatarUrl: 'https://remote.social/node-controlled-avatar.jpg',
    };
    mocks.usersFindFirst.mockImplementation(async ({ where }) => {
      if (where.did === recipientDid) {
        return {
          id: 'recipient-id',
          did: recipientDid,
          handle: 'bob@local.social',
          username: 'bob',
          homeDomain: 'local.social',
          isLocalAccount: true,
          dmPrivacy: 'all',
        };
      }
      if (where.did === senderDid || where.handle === 'alice@remote.social') {
        return cachedSender;
      }
      return null;
    });

    const response = await POST(request() as never);

    expect(response.status).toBe(200);
    expect(mocks.messageValues).toHaveBeenCalledWith(expect.objectContaining({
      senderDisplayName: 'alice',
      senderAvatarUrl: null,
    }));
  });

  it('checks durable identity continuity before accepting a replay', async () => {
    mocks.receiptInsertResult.mockResolvedValue([]);

    const response = await POST(request() as never);

    expect(response.status).toBe(200);
    expect(mocks.transactionEvents).toEqual(['identity', 'receipt']);
    expect(mocks.messageValues).not.toHaveBeenCalled();
    expect(mocks.enqueueMessagePushDeliveries).not.toHaveBeenCalled();
  });

  it('rejects before claiming replay when the verified handle pin belongs to another DID', async () => {
    mocks.pinVerifiedFederatedActorIdentity.mockImplementation(async () => {
      mocks.transactionEvents.push('identity');
      throw new FederatedIdentityContinuityError();
    });

    const response = await POST(request() as never);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'E2EE_IDENTITY_KEY_CHANGED',
    });
    expect(mocks.transactionEvents).toEqual(['identity']);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.receiptValues).not.toHaveBeenCalled();
    expect(mocks.messageValues).not.toHaveBeenCalled();
  });
});
