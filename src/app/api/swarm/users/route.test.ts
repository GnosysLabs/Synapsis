import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  from: vi.fn(),
  where: vi.fn(),
  orderBy: vi.fn(),
  limit: vi.fn(),
  isNull: vi.fn((column: unknown) => ({ operator: 'isNull', column })),
  notLike: vi.fn((column: unknown, pattern: string) => ({ operator: 'notLike', column, pattern })),
  localNodeIsNsfw: vi.fn(),
  authorizeFederationRead: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...conditions: unknown[]) => ({ operator: 'and', conditions })),
  asc: vi.fn((column: unknown) => ({ operator: 'asc', column })),
  eq: vi.fn((column: unknown, value: unknown) => ({ operator: 'eq', column, value })),
  isNull: mocks.isNull,
  like: vi.fn((column: unknown, pattern: string) => ({ operator: 'like', column, pattern })),
  notLike: mocks.notLike,
  or: vi.fn((...conditions: unknown[]) => ({ operator: 'or', conditions })),
}));

vi.mock('@/db', () => ({
  db: { select: mocks.select },
  users: {
    handle: 'users.handle',
    displayName: 'users.displayName',
    avatarUrl: 'users.avatarUrl',
    isNsfw: 'users.isNsfw',
    nodeId: 'users.nodeId',
    isSuspended: 'users.isSuspended',
    isSilenced: 'users.isSilenced',
  },
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

describe('GET /api/swarm/users local origin boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.select.mockReturnValue({ from: mocks.from });
    mocks.from.mockReturnValue({ where: mocks.where });
    mocks.where.mockReturnValue({ orderBy: mocks.orderBy });
    mocks.orderBy.mockReturnValue({ limit: mocks.limit });
    mocks.localNodeIsNsfw.mockResolvedValue(false);
    mocks.authorizeFederationRead.mockResolvedValue({ ok: true, sourceDomain: 'peer.example' });
  });

  it('exports only unqualified users with a null nodeId', async () => {
    mocks.limit.mockResolvedValue([
      {
        handle: 'local',
        displayName: 'Local User',
        avatarUrl: 'https://local.example/avatar.jpg',
        isNsfw: false,
        nodeId: null,
      },
      {
        handle: 'cached@remote.example',
        displayName: 'Cached Remote',
        avatarUrl: 'https://remote.example/avatar.jpg',
        isNsfw: false,
        nodeId: null,
      },
      {
        handle: 'linkedremote',
        displayName: 'Linked Remote',
        avatarUrl: 'https://remote.example/linked.jpg',
        isNsfw: false,
        nodeId: 'remote-node-id',
      },
    ]);

    const response = await GET(new NextRequest('https://local.example/api/swarm/users?q='));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.users).toEqual([{
      handle: 'local',
      displayName: 'Local User',
      avatarUrl: 'https://local.example/avatar.jpg',
      isNsfw: false,
      isRemote: false,
      nodeIsNsfw: false,
    }]);
    expect(mocks.isNull).toHaveBeenCalledWith('users.nodeId');
    expect(mocks.notLike).toHaveBeenCalledWith('users.handle', '%@%');
  });
});
