import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyFederatedUserAction: vi.fn(),
  pinVerifiedFederatedActorIdentity: vi.fn(),
  usersFindFirst: vi.fn(),
  mutedNodeFindFirst: vi.fn(),
  blockFindFirst: vi.fn(),
  muteFindFirst: vi.fn(),
  inboundActionValues: vi.fn(),
  notificationValues: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@/lib/swarm/federated-action', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/swarm/federated-action')>();
  return {
    ...actual,
    verifyFederatedUserAction: mocks.verifyFederatedUserAction,
    pinVerifiedFederatedActorIdentity: mocks.pinVerifiedFederatedActorIdentity,
  };
});

vi.mock('@/db', () => {
  const swarmInboundActions = { id: 'id' };
  const notifications = { id: 'id' };

  const tx = {
    insert: vi.fn((table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        if (table === swarmInboundActions) {
          mocks.inboundActionValues(values);
          return {
            onConflictDoNothing: () => ({
              returning: async () => [{ id: 'inbound-action-id' }],
            }),
          };
        }

        mocks.notificationValues(values);
        return {
          onConflictDoNothing: () => Promise.resolve(),
        };
      },
    })),
  };

  mocks.transaction.mockImplementation(async (callback: (value: typeof tx) => unknown) => callback(tx));

  return {
    swarmInboundActions,
    notifications,
    db: {
      query: {
        users: { findFirst: mocks.usersFindFirst },
        mutedNodes: { findFirst: mocks.mutedNodeFindFirst },
        blocks: { findFirst: mocks.blockFindFirst },
        mutes: { findFirst: mocks.muteFindFirst },
      },
      transaction: mocks.transaction,
    },
  };
});

import { POST } from './route';

const interactionId = '550e8400-e29b-41d4-a716-446655440000';
const postId = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const replayId = '7cc9f0e9-6f1f-49d1-83ac-c98cfdbd5819';
const actorDid = 'did:key:zRemoteSigner';
const authorizedContent = 'Hello @localuser@local.social';

function payload(content = authorizedContent) {
  const now = Date.now();
  return {
    federation: {
      protocol: 'synapsis-federation-action-v2',
      sourceDomain: 'remote.social',
      destinationDomain: 'local.social',
      method: 'POST',
      path: '/api/swarm/interactions/mention',
      issuedAt: now,
      expiresAt: now + 5 * 60 * 1_000,
    },
    userAction: {
      action: 'post',
      data: {
        clientPostId: postId,
        content,
        mediaIds: [],
        mediaManifest: [],
        isNsfw: false,
      },
      did: actorDid,
      handle: 'remoteuser',
      ts: now,
      nonce: 'mention_nonce_1',
      sig: 'mention_signature_1',
    },
    mentionedHandle: 'localuser',
    mention: {
      actorHandle: 'remoteuser',
      actorDisplayName: 'Remote User',
      actorNodeDomain: 'remote.social',
      actorDid,
      postId,
      postContent: content,
      interactionId,
      timestamp: new Date(now).toISOString(),
    },
    signature: 'node-signature',
  } as const;
}

function request(content = authorizedContent) {
  return new Request('https://local.social/api/swarm/interactions/mention', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload(content)),
  });
}

describe('swarm mention receiver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyFederatedUserAction.mockImplementation(async ({ payload: verifiedPayload }) => ({
      ok: true,
      actorHandle: 'remoteuser',
      sourceDomain: 'remote.social',
      destinationDomain: 'local.social',
      userAction: verifiedPayload.userAction,
      replayId,
    }));
    mocks.usersFindFirst
      .mockResolvedValueOnce({
        id: 'recipient-id',
        handle: 'localuser',
        nodeId: null,
        isSuspended: false,
      })
      .mockResolvedValueOnce(null);
    mocks.mutedNodeFindFirst.mockResolvedValue(null);
    mocks.blockFindFirst.mockResolvedValue(null);
    mocks.muteFindFirst.mockResolvedValue(null);
  });

  it('stores an idempotent, navigable remote post reference', async () => {
    const response = await POST(request() as never);

    expect(response.status).toBe(200);
    expect(mocks.verifyFederatedUserAction).toHaveBeenCalledWith(expect.objectContaining({
      sourceDomain: 'remote.social',
      expectedMethod: 'POST',
      expectedPath: '/api/swarm/interactions/mention',
      expectedAction: 'post',
      actorHandle: 'remoteuser',
      replayBinding: { mentionedHandle: 'localuser', postId },
    }));
    expect(mocks.pinVerifiedFederatedActorIdentity).toHaveBeenCalledWith({
      sourceDomain: 'remote.social',
      actorHandle: 'remoteuser',
      did: actorDid,
    }, expect.anything());
    expect(mocks.inboundActionValues).toHaveBeenCalledWith({
      sourceDomain: 'remote.social',
      action: 'mention',
      interactionId: replayId,
    });
    expect(mocks.notificationValues).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'recipient-id',
      interactionId: `mention:remote:remote.social:${replayId}`,
      remotePostId: postId,
      remotePostDomain: 'remote.social',
      actorNodeDomain: 'remote.social',
      type: 'mention',
    }));
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });

  it('acknowledges but suppresses a mention from a muted node', async () => {
    mocks.mutedNodeFindFirst.mockResolvedValue({ id: 'mute-id' });

    const response = await POST(request() as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.notificationValues).not.toHaveBeenCalled();
  });

  it('rejects an invalid node or user proof before resolving the recipient', async () => {
    mocks.verifyFederatedUserAction.mockResolvedValue({
      ok: false,
      error: 'Invalid federation authorization',
      status: 403,
    });

    const response = await POST(request() as never);

    expect(response.status).toBe(403);
    expect(mocks.usersFindFirst).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('rejects a valid user proof that does not authorize the delivered mention target', async () => {
    const response = await POST(request('Hello @somebody@local.social') as never);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Mention target is not user-authorized',
    });
    expect(mocks.usersFindFirst).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('rejects a node-supplied post ID that differs from the signed post ID', async () => {
    const original = payload();
    const tampered = {
      ...original,
      mention: {
        ...original.mention,
        postId: 'a5d25b3e-c9a3-4c61-9365-b7cf3a6ae108',
      },
    };
    const response = await POST(new Request(
      'https://local.social/api/swarm/interactions/mention',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tampered),
      },
    ) as never);

    expect(response.status).toBe(403);
    expect(mocks.usersFindFirst).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
