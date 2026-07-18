import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  and: vi.fn((...conditions: unknown[]) => ({ operator: 'and', conditions })),
  notLike: vi.fn((column: unknown, pattern: string) => ({ operator: 'notLike', column, pattern })),
  like: vi.fn((column: unknown, pattern: string) => ({ operator: 'like', column, pattern })),
  requireLocalNodeNsfwClassification: vi.fn(),
  isTrustedFederationRead: vi.fn(),
}));

vi.mock('@/db', () => {
  const columns = new Proxy({}, {
    get: (_target, property) => String(property),
  });

  return {
    db: {
      select: mocks.select,
      query: {
        remoteReposts: { findMany: vi.fn() },
        posts: { findMany: vi.fn() },
      },
    },
    posts: columns,
    users: columns,
    media: columns,
    remoteReposts: columns,
  };
});

vi.mock('drizzle-orm', () => {
  const expression = (operator: string) => (...values: unknown[]) => ({ operator, values });
  const sql = () => ({ mapWith: () => ({ operator: 'mappedSql' }) });

  return {
    eq: expression('eq'),
    desc: expression('desc'),
    and: mocks.and,
    isNull: expression('isNull'),
    lt: expression('lt'),
    inArray: expression('inArray'),
    like: mocks.like,
    notLike: mocks.notLike,
    sql,
  };
});

vi.mock('@/lib/node/local-node', () => ({
  requireLocalNodeNsfwClassification: mocks.requireLocalNodeNsfwClassification,
}));

vi.mock('@/lib/swarm/signed-read', () => ({
  isTrustedFederationRead: mocks.isTrustedFederationRead,
}));

vi.mock('@/lib/media/linkPreview', () => ({
  parseLinkPreviewMediaJson: vi.fn(() => undefined),
}));

vi.mock('@/lib/posts/remote-reposts', () => ({
  attachRemoteRepostSummaries: vi.fn((posts) => posts),
}));

vi.mock('@/lib/nsfw/content-visibility', () => ({
  redactSensitivePostForViewer: vi.fn((post) => post),
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

describe('GET /api/swarm/timeline local-author boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'local.example');
    mocks.requireLocalNodeNsfwClassification.mockResolvedValue(false);
    mocks.isTrustedFederationRead.mockResolvedValue(true);
  });

  it('excludes qualified cached-remote handles from both timeline source queries', async () => {
    const recentPostsQuery = emptySelectBuilder();
    const remoteActivityQuery = emptySelectBuilder();
    mocks.select
      .mockReturnValueOnce(recentPostsQuery)
      .mockReturnValueOnce(remoteActivityQuery);

    const response = await GET(
      new Request('https://local.example/api/swarm/timeline') as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ posts: [] });
    expect(mocks.notLike).toHaveBeenCalledTimes(2);
    expect(mocks.notLike).toHaveBeenNthCalledWith(1, 'handle', '%@%');
    expect(mocks.notLike).toHaveBeenNthCalledWith(2, 'handle', '%@%');
    expect(recentPostsQuery.where).toHaveBeenCalledOnce();
    expect(remoteActivityQuery.where).toHaveBeenCalledOnce();
  });

  it('applies a post-content query to both timeline source queries', async () => {
    const recentPostsQuery = emptySelectBuilder();
    const remoteActivityQuery = emptySelectBuilder();
    mocks.select
      .mockReturnValueOnce(recentPostsQuery)
      .mockReturnValueOnce(remoteActivityQuery);

    const response = await GET(
      new Request('https://local.example/api/swarm/timeline?q=Yolked') as never,
    );

    expect(response.status).toBe(200);
    expect(mocks.like).toHaveBeenCalledOnce();
    expect(mocks.like).toHaveBeenCalledWith('content', '%Yolked%');
    const searchCondition = mocks.like.mock.results[0]?.value;
    expect(mocks.and).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      searchCondition,
    );
  });
});
