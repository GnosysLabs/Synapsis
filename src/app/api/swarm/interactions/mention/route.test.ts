import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifySwarmRequest: vi.fn(),
  usersFindFirst: vi.fn(),
  mutedNodeFindFirst: vi.fn(),
  blockFindFirst: vi.fn(),
  muteFindFirst: vi.fn(),
  notificationValues: vi.fn(),
  notificationReturning: vi.fn(),
}));

vi.mock('@/lib/swarm/signature', () => ({
  verifySwarmRequest: mocks.verifySwarmRequest,
}));

vi.mock('@/db', () => ({
  notifications: { id: 'id' },
  db: {
    query: {
      users: { findFirst: mocks.usersFindFirst },
      mutedNodes: { findFirst: mocks.mutedNodeFindFirst },
      blocks: { findFirst: mocks.blockFindFirst },
      mutes: { findFirst: mocks.muteFindFirst },
    },
    insert: vi.fn(() => ({
      values: (values: unknown) => {
        mocks.notificationValues(values);
        return {
          onConflictDoNothing: () => ({
            returning: mocks.notificationReturning,
            then: (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
          }),
        };
      },
    })),
  },
}));

import { POST } from './route';

const interactionId = '550e8400-e29b-41d4-a716-446655440000';
const postId = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';

function request() {
  return new Request('https://local.example/api/swarm/interactions/mention', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mentionedHandle: 'localuser',
      mention: {
        actorHandle: 'remoteuser',
        actorDisplayName: 'Remote User',
        actorNodeDomain: 'remote.example',
        postId,
        postContent: 'Hello @localuser@local.example',
        interactionId,
        timestamp: '2026-07-15T22:00:00.000Z',
      },
      signature: 'signed',
    }),
  });
}

describe('swarm mention receiver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifySwarmRequest.mockResolvedValue(true);
    mocks.usersFindFirst
      .mockResolvedValueOnce({
        id: 'recipient-id',
        handle: 'localuser',
        isSuspended: false,
      })
      .mockResolvedValueOnce(null);
    mocks.mutedNodeFindFirst.mockResolvedValue(null);
    mocks.blockFindFirst.mockResolvedValue(null);
    mocks.muteFindFirst.mockResolvedValue(null);
    mocks.notificationReturning.mockResolvedValue([{ id: 'notification-id' }]);
  });

  it('stores an idempotent, navigable remote post reference', async () => {
    const response = await POST(request() as never);

    expect(response.status).toBe(200);
    expect(mocks.notificationValues).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'recipient-id',
      interactionId: `mention:remote:remote.example:${interactionId}`,
      remotePostId: postId,
      remotePostDomain: 'remote.example',
      actorNodeDomain: 'remote.example',
      type: 'mention',
    }));
    expect(mocks.notificationReturning).toHaveBeenCalledOnce();
  });

  it('acknowledges but suppresses a mention from a muted node', async () => {
    mocks.mutedNodeFindFirst.mockResolvedValue({ id: 'mute-id' });

    const response = await POST(request() as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
    expect(mocks.notificationValues).not.toHaveBeenCalled();
  });

  it('rejects an invalid node signature before resolving the recipient', async () => {
    mocks.verifySwarmRequest.mockResolvedValue(false);

    const response = await POST(request() as never);

    expect(response.status).toBe(403);
    expect(mocks.usersFindFirst).not.toHaveBeenCalled();
  });
});
