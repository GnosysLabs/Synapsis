import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  getSession: vi.fn(),
  requireLocalNodeNsfwClassification: vi.fn(),
  notLike: vi.fn((column: unknown, pattern: string) => ({ operator: 'notLike', column, pattern })),
}));

vi.mock('@/db', () => {
  const columns = (table: string) => new Proxy({}, {
    get: (_target, property) => `${table}.${String(property)}`,
  });

  return {
    db: {
      select: mocks.select,
      query: {},
    },
    posts: columns('posts'),
    users: columns('users'),
    media: columns('media'),
    follows: columns('follows'),
    mutes: columns('mutes'),
    blocks: columns('blocks'),
    mutedNodes: columns('mutedNodes'),
    remotePosts: columns('remotePosts'),
    remoteReposts: columns('remoteReposts'),
    userSwarmReposts: columns('userSwarmReposts'),
    notifications: columns('notifications'),
    feedStories: columns('feedStories'),
    remoteFeedStories: columns('remoteFeedStories'),
  };
});

vi.mock('drizzle-orm', () => {
  const expression = (operator: string) => (...values: unknown[]) => ({ operator, values });
  const sql = () => ({ mapWith: () => ({ operator: 'mappedSql' }) });

  return {
    eq: expression('eq'),
    and: expression('and'),
    desc: expression('desc'),
    inArray: expression('inArray'),
    isNull: expression('isNull'),
    lt: expression('lt'),
    ne: expression('ne'),
    notLike: mocks.notLike,
    sql,
  };
});

vi.mock('@/lib/auth', () => ({
  getSession: mocks.getSession,
  requireAuth: vi.fn(),
}));

vi.mock('@/lib/auth/verify-signature', () => ({
  requireSignedAction: vi.fn(),
}));

vi.mock('@/lib/node/local-node', () => ({
  requireLocalNodeNsfwClassification: mocks.requireLocalNodeNsfwClassification,
}));

vi.mock('@/lib/posts/node-feed', () => ({
  assembleNodeFeedStories: vi.fn(() => []),
  collapseSharedFeedPosts: vi.fn((posts) => posts),
  mergeNodeFeedActivities: vi.fn((groups) => groups.flat()),
  setReposterInSummary: vi.fn(),
}));

vi.mock('@/lib/nsfw/content-visibility', () => ({
  redactSensitivePostForViewer: vi.fn((post) => post),
}));

vi.mock('@/lib/mentions/delivery', () => ({
  registerPostMentions: vi.fn(),
}));

vi.mock('@/lib/swarm/node-blocklist', () => ({
  getBlockedNodeDomains: vi.fn().mockResolvedValue(new Set()),
}));

import { GET } from './route';

function emptySelectBuilder() {
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ['from', 'innerJoin', 'where', 'groupBy', 'orderBy']) {
    builder[method] = vi.fn(() => builder);
  }
  builder.limit = vi.fn().mockResolvedValue([]);
  return builder;
}

describe('GET /api/posts local node origin boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'local.example');
    mocks.getSession.mockResolvedValue(null);
    mocks.requireLocalNodeNsfwClassification.mockResolvedValue(false);
    mocks.select.mockImplementation(() => emptySelectBuilder());
  });

  it('requires local activity authors in the materialized node-story query', async () => {
    const response = await GET(
      new Request('https://local.example/api/posts?type=local'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ posts: [] });
    expect(mocks.notLike).toHaveBeenCalledTimes(1);
    expect(mocks.notLike).toHaveBeenNthCalledWith(1, 'users.handle', '%@%');
  });
});
