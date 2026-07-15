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
          isBot: false,
        },
        {
          handle: 'bob',
          displayName: 'Bob',
          avatarUrl: '/bob.png',
          did: 'did:key:bob',
          publicKey: 'bob-signing-key',
          isBot: false,
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
});
