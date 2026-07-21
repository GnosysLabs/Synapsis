import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  select: vi.fn(),
  localNodeIsNsfw: vi.fn(),
  authorizeFederationRead: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: {
    query: {
      users: { findFirst: mocks.findUser },
      remoteFollowers: { findMany: vi.fn() },
    },
    select: mocks.select,
  },
  follows: {},
  users: {},
}));

vi.mock('@/lib/node/local-node', () => ({
  requireLocalNodeNsfwClassification: mocks.localNodeIsNsfw,
}));

vi.mock('@/lib/swarm/signed-read', () => ({
  authorizeFederationRead: mocks.authorizeFederationRead,
  federationReadFailureResponse: (authorization: { status: number; code: string; error: string }) =>
    Response.json({ error: authorization.error, code: authorization.code }, { status: authorization.status }),
}));

import { GET } from './route';

describe('GET /api/swarm/users/[handle]/followers local origin boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'local.example');
    mocks.localNodeIsNsfw.mockResolvedValue(false);
    mocks.authorizeFederationRead.mockResolvedValue({ ok: true, sourceDomain: 'peer.example' });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('rejects a qualified remote target before querying the user cache', async () => {
    const response = await GET(
      new Request('https://local.example/api/swarm/users/user%40remote.example/followers') as never,
      { params: Promise.resolve({ handle: 'user@remote.example' }) },
    );

    expect(response.status).toBe(404);
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it('rejects a target row not explicitly owned by this node', async () => {
    mocks.findUser.mockResolvedValue({
      id: 'remote-user-id',
      handle: 'remoteuser@local.example',
      username: 'remoteuser',
      homeDomain: 'local.example',
      isLocalAccount: false,
      isSuspended: false,
    });

    const response = await GET(
      new Request('https://local.example/api/swarm/users/remoteuser/followers') as never,
      { params: Promise.resolve({ handle: 'remoteuser' }) },
    );

    expect(response.status).toBe(404);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.findUser).toHaveBeenCalledWith({
      where: {
        AND: [
          { username: 'remoteuser' },
          { homeDomain: 'local.example' },
          { isLocalAccount: true },
        ],
      },
    });
  });
});
