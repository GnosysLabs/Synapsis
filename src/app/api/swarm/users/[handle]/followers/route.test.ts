import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  select: vi.fn(),
  localNodeIsNsfw: vi.fn(),
  trustedRead: vi.fn(),
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
  isTrustedFederationRead: mocks.trustedRead,
}));

vi.mock('@/lib/swarm/user-hydration', () => ({
  hydrateSwarmUsers: vi.fn(),
}));

import { GET } from './route';

describe('GET /api/swarm/users/[handle]/followers local origin boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.localNodeIsNsfw.mockResolvedValue(false);
    mocks.trustedRead.mockResolvedValue(true);
  });

  it('rejects a qualified remote target before querying the user cache', async () => {
    const response = await GET(
      new Request('https://local.example/api/swarm/users/user%40remote.example/followers') as never,
      { params: Promise.resolve({ handle: 'user@remote.example' }) },
    );

    expect(response.status).toBe(404);
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it('rejects an unqualified target row linked to a remote node', async () => {
    mocks.findUser.mockResolvedValue({
      id: 'remote-user-id',
      handle: 'remoteuser',
      nodeId: 'remote-node-id',
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
          { handle: 'remoteuser' },
          { nodeId: { isNull: true } },
        ],
      },
    });
  });
});
