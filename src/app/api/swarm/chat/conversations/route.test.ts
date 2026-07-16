import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findConversations: vi.fn(),
  getSession: vi.fn(),
  select: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ getSession: mocks.getSession }));

vi.mock('@/db', async () => {
  const schema = await vi.importActual<typeof import('@/db/schema')>('@/db/schema');
  return {
    ...schema,
    db: {
      query: {
        chatConversations: { findMany: mocks.findConversations },
      },
      select: mocks.select,
    },
  };
});

import { GET } from './route';

function selectResult(rows: unknown[], grouped = false) {
  const terminal = vi.fn().mockResolvedValue(rows);
  const where = grouped
    ? vi.fn(() => ({ groupBy: terminal }))
    : terminal;
  return {
    from: vi.fn(() => ({ where })),
  };
}

describe('GET /api/swarm/chat/conversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'local.example');
    vi.stubGlobal('fetch', vi.fn());
    mocks.getSession.mockResolvedValue({
      user: {
        id: 'owner-id',
        did: 'did:key:owner',
        handle: 'owner',
        publicKey: 'owner-signing-key',
      },
    });
  });

  it('batches local metadata and never contacts remote nodes on the inbox path', async () => {
    mocks.findConversations.mockResolvedValue([
      {
        id: 'remote-conversation',
        participant1Id: 'owner-id',
        participant2Handle: 'alice@offline.example',
        messages: [],
      },
      {
        id: 'local-conversation',
        participant1Id: 'owner-id',
        participant2Handle: 'bob@local.example',
        messages: [],
      },
    ]);
    mocks.select
      .mockReturnValueOnce(selectResult([
        { conversationId: 'remote-conversation', count: 2 },
      ], true))
      .mockReturnValueOnce(selectResult([
        {
          handle: 'alice@offline.example',
          displayName: 'Alice',
          avatarUrl: null,
          did: 'did:key:alice',
          publicKey: 'alice-signing-key',
        },
        {
          handle: 'bob',
          displayName: 'Bob',
          avatarUrl: '/bob.png',
          did: 'did:key:bob',
          publicKey: 'bob-signing-key',
        },
      ]));

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.select).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(body.conversations).toMatchObject([
      {
        id: 'remote-conversation',
        participant2: { handle: 'alice@offline.example', displayName: 'Alice' },
        unreadCount: 2,
      },
      {
        id: 'local-conversation',
        participant2: { handle: 'bob', displayName: 'Bob' },
        unreadCount: 0,
      },
    ]);
  });

  it('returns an empty inbox without issuing aggregate queries', async () => {
    mocks.findConversations.mockResolvedValue([]);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ conversations: [] });
    expect(mocks.select).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resolves an encrypted preview signing key by sender DID across nodes', async () => {
    const senderDid = 'did:synapsis:remote-alice';
    const encryptedEnvelope = {
      protocol: 'synapsis-e2ee-v1',
      cipherSuite: 'x25519+xchacha20poly1305+blake2b-v1',
      messageId: '11111111-1111-4111-8111-111111111111',
      conversationId: 'dm1_conversation123',
      senderDid,
      senderHandle: 'alice',
      recipientDid: 'did:key:owner',
      recipientHandle: 'owner',
      createdAt: 1_700_000_000_000,
      senderKeyId: 'k1_sender_key_123',
      senderKeyVersion: 1,
      recipientKeyId: 'k1_recipient_key_123',
      recipientKeyVersion: 1,
      nonce: 'nonce',
      ciphertext: 'ciphertext',
      keyCommitment: 'commitment',
      keyEnvelopes: [{
        did: 'did:key:owner',
        keyId: 'k1_recipient_key_123',
        keyVersion: 1,
        sealedKey: 'sealed_key',
      }],
    };
    mocks.findConversations.mockResolvedValue([{
      id: 'remote-conversation',
      participant1Id: 'owner-id',
      participant2Handle: 'alice@remote.example',
      messages: [{
        id: 'latest-message',
        protocolVersion: 1,
        content: null,
        encryptedEnvelope: JSON.stringify(encryptedEnvelope),
        senderDid,
        e2eeSignature: 'signature',
        e2eeActionNonce: 'action_nonce',
        e2eeActionTs: encryptedEnvelope.createdAt,
      }],
    }]);
    mocks.select
      .mockReturnValueOnce(selectResult([], true))
      .mockReturnValueOnce(selectResult([{
        // Deliberately does not match participant2Handle. The message DID is
        // the stable identity used for signature verification.
        handle: 'alice@canonical.example',
        displayName: 'Alice',
        avatarUrl: null,
        did: senderDid,
        publicKey: 'alice-signing-key',
      }]));

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.conversations[0].lastMessage).toMatchObject({
      protocolVersion: 1,
      senderPublicKey: 'alice-signing-key',
      signedAction: { did: senderDid },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
