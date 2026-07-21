import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  findConversations: vi.fn(),
  getSession: vi.fn(),
  select: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ getSession: mocks.getSession }));

vi.mock('@/lib/node/local-node', () => ({
  requireLocalNodeNsfwClassification: vi.fn().mockResolvedValue(false),
}));

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

function request(query = '') {
  return new NextRequest(`https://local.example/api/swarm/chat/conversations${query}`);
}

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
        handle: 'owner@local.example',
        username: 'owner',
        homeDomain: 'local.example',
        isLocalAccount: true,
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
      },
      {
        id: 'local-conversation',
        participant1Id: 'owner-id',
        participant2Handle: 'bob@local.example',
      },
    ]);
    mocks.select
      .mockReturnValueOnce(selectResult([
        { conversationId: 'remote-conversation', count: 2 },
      ], true))
      .mockReturnValueOnce(selectResult([]))
      .mockReturnValueOnce(selectResult([
        {
          handle: 'alice@offline.example',
          displayName: 'Alice',
          avatarUrl: null,
          did: 'did:key:alice',
          publicKey: 'alice-signing-key',
          homeDomain: 'offline.example',
          isLocalAccount: false,
        },
        {
          handle: 'bob@local.example',
          displayName: 'Bob',
          avatarUrl: '/bob.png',
          did: 'did:key:bob',
          publicKey: 'bob-signing-key',
          homeDomain: 'local.example',
          isLocalAccount: true,
        },
      ]));

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.findConversations).toHaveBeenCalledWith(expect.not.objectContaining({
      with: expect.anything(),
    }));
    expect(mocks.findConversations).toHaveBeenCalledWith(expect.objectContaining({
      limit: 51,
      offset: 0,
    }));
    expect(mocks.select).toHaveBeenCalledTimes(3);
    expect(fetch).not.toHaveBeenCalled();
    expect(body.conversations).toMatchObject([
      {
        id: 'remote-conversation',
        participant2: { handle: 'alice@offline.example', displayName: 'Alice' },
        unreadCount: 2,
      },
      {
        id: 'local-conversation',
        participant2: { handle: 'bob@local.example', displayName: 'Bob' },
        unreadCount: 0,
      },
    ]);
  });

  it('returns an empty inbox without issuing aggregate queries', async () => {
    mocks.findConversations.mockResolvedValue([]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ conversations: [], nextOffset: null });
    expect(mocks.select).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resolves an encrypted preview signing key by sender DID across nodes', async () => {
    const senderDid = 'did:synapsis:remote-alice';
    // Historical encrypted payloads retain their exact signed bare handles.
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
    }]);
    mocks.select
      .mockReturnValueOnce(selectResult([], true))
      .mockReturnValueOnce(selectResult([{
        id: 'latest-message',
        conversationId: 'remote-conversation',
        protocolVersion: 1,
        content: null,
        encryptedEnvelope: JSON.stringify(encryptedEnvelope),
        senderDid,
        e2eeSignature: 'signature',
        e2eeActionNonce: 'action_nonce',
        e2eeActionTs: encryptedEnvelope.createdAt,
      }]))
      .mockReturnValueOnce(selectResult([{
        // Deliberately does not match participant2Handle. The message DID is
        // the stable identity used for signature verification.
        handle: 'alice@canonical.example',
        displayName: 'Alice',
        avatarUrl: null,
        did: senderDid,
        publicKey: 'alice-signing-key',
        homeDomain: 'canonical.example',
        isLocalAccount: false,
      }]));

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.conversations[0].lastMessage).toMatchObject({
      protocolVersion: 1,
      senderPublicKey: 'alice-signing-key',
      signedAction: { did: senderDid },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns a latest message for every conversation instead of applying one nested limit globally', async () => {
    mocks.findConversations.mockResolvedValue([
      {
        id: 'first-conversation',
        participant1Id: 'owner-id',
        participant2Handle: 'alice@first.example',
      },
      {
        id: 'second-conversation',
        participant1Id: 'owner-id',
        participant2Handle: 'bob@second.example',
      },
    ]);
    mocks.select
      .mockReturnValueOnce(selectResult([], true))
      .mockReturnValueOnce(selectResult([
        {
          id: 'first-message',
          conversationId: 'first-conversation',
          protocolVersion: 0,
          content: 'first preview',
          senderDid: null,
        },
        {
          id: 'second-message',
          conversationId: 'second-conversation',
          protocolVersion: 0,
          content: 'second preview',
          senderDid: null,
        },
      ]))
      .mockReturnValueOnce(selectResult([]));

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.conversations).toMatchObject([
      {
        id: 'first-conversation',
        lastMessage: { protocolVersion: 0, content: 'first preview' },
      },
      {
        id: 'second-conversation',
        lastMessage: { protocolVersion: 0, content: 'second preview' },
      },
    ]);
  });

  it('caps all downstream inbox work to the requested page', async () => {
    mocks.findConversations.mockResolvedValue([
      { id: 'first', participant1Id: 'owner-id', participant2Handle: 'one@remote.example' },
      { id: 'second', participant1Id: 'owner-id', participant2Handle: 'two@remote.example' },
      { id: 'sentinel', participant1Id: 'owner-id', participant2Handle: 'three@remote.example' },
    ]);
    mocks.select
      .mockReturnValueOnce(selectResult([], true))
      .mockReturnValueOnce(selectResult([]))
      .mockReturnValueOnce(selectResult([]));

    const response = await GET(request('?limit=2'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.findConversations).toHaveBeenCalledWith(expect.objectContaining({
      limit: 3,
      offset: 0,
    }));
    expect(body.conversations.map((conversation: { id: string }) => conversation.id))
      .toEqual(['first', 'second']);
    expect(body.nextOffset).toBe(2);
  });
});
