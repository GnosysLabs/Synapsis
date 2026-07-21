import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  localNodeIsNsfw: vi.fn(),
  activeNodes: vi.fn(),
  signedRead: vi.fn(),
  searchKnownUsers: vi.fn(),
  select: vi.fn(),
}));

function queryBuilder(rows: unknown[]) {
  const builder = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn().mockResolvedValue(rows),
    then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => (
      Promise.resolve(rows).then(resolve, reject)
    ),
  };
  builder.from.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  return builder;
}

vi.mock('drizzle-orm', () => {
  const expression = (operator: string) => (...values: unknown[]) => ({ operator, values });
  return {
    and: expression('and'),
    eq: expression('eq'),
    like: expression('like'),
    notLike: expression('notLike'),
    or: expression('or'),
  };
});

vi.mock('@/db', () => {
  const columns = new Proxy({}, { get: (_target, property) => String(property) });
  return {
    db: { select: mocks.select },
    blocks: columns,
    mutedNodes: columns,
    mutes: columns,
    remoteFollows: columns,
    users: columns,
  };
});

vi.mock('@/lib/auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/node/local-node', () => ({
  requireLocalNodeNsfwClassification: mocks.localNodeIsNsfw,
}));
vi.mock('@/lib/swarm/registry', () => ({
  getActiveSwarmNodes: mocks.activeNodes,
  getKnownSwarmNodeNsfw: vi.fn(),
}));
vi.mock('@/lib/swarm/signed-read', () => ({ signedFederationRead: mocks.signedRead }));
vi.mock('@/lib/swarm/user-directory-search', () => ({
  searchKnownSwarmUsers: mocks.searchKnownUsers,
}));
vi.mock('@/lib/swarm/interactions', () => ({ isSwarmNode: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/swarm/discovery', () => ({ discoverNode: vi.fn() }));

import { GET } from './route';

describe('GET /api/mentions/suggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'local.com');
    mocks.requireAuth.mockResolvedValue({
      id: 'viewer-id',
      nsfwEnabled: false,
      ageVerifiedAt: null,
    });
    mocks.localNodeIsNsfw.mockResolvedValue(false);
    mocks.activeNodes.mockResolvedValue([
      { domain: 'one.com', isNsfw: false },
      { domain: 'two.com', isNsfw: false },
    ]);
    mocks.searchKnownUsers.mockResolvedValue([
      {
        handle: 'alex@one.com',
        displayName: 'Alex Remote',
        avatarUrl: null,
        isRemote: true,
        nodeDomain: 'one.com',
        isNsfw: false,
        nodeIsNsfw: false,
      },
      {
        handle: 'alina@two.com',
        displayName: 'Alina Remote',
        avatarUrl: null,
        isRemote: true,
        nodeDomain: 'two.com',
        isNsfw: false,
        nodeIsNsfw: false,
      },
    ]);
    mocks.select.mockImplementation((selection: Record<string, unknown>) => {
      if ('blockedUserId' in selection || 'mutedUserId' in selection || 'nodeDomain' in selection) {
        return queryBuilder([]);
      }
      if ('isNsfw' in selection) {
        return queryBuilder([
          { id: 'local-alex', handle: 'alex@local.com', displayName: 'Alex Local', avatarUrl: null, isNsfw: false },
          { id: 'local-alice', handle: 'alice@local.com', displayName: 'Alice Local', avatarUrl: null, isNsfw: false },
        ]);
      }
      return queryBuilder([]);
    });
    mocks.signedRead.mockImplementation(async (url: string) => {
      const domain = new URL(url).hostname;
      return {
        status: 200,
        json: () => ({
          users: [{
            handle: domain === 'one.com' ? 'alex' : 'alina',
            displayName: domain === 'one.com' ? 'Alex Remote' : 'Alina Remote',
            avatarUrl: null,
            isNsfw: false,
            nodeIsNsfw: false,
          }],
        }),
      };
    });
  });

  it('surfaces matching users from active remote nodes without a typed domain', async () => {
    const response = await GET(new NextRequest(
      'https://local.com/api/mentions/suggestions?q=al&limit=4',
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      suggestions: [
        { handle: 'alex@local.com', isRemote: false },
        { handle: 'alex@one.com', isRemote: true },
        { handle: 'alice@local.com', isRemote: false },
        { handle: 'alina@two.com', isRemote: true },
      ],
    });
    expect(mocks.searchKnownUsers).toHaveBeenCalledWith(
      'al',
      expect.objectContaining({
        limit: 4,
        localDomain: 'local.com',
        timeoutMs: 1_500,
      }),
    );
  });
});
