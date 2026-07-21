import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  and: vi.fn((...conditions: unknown[]) => ({ operator: 'and', conditions })),
  notLike: vi.fn((column: unknown, pattern: string) => ({ operator: 'notLike', column, pattern })),
  inArray: vi.fn((column: unknown, values: unknown[]) => ({ operator: 'inArray', column, values })),
  gt: vi.fn((column: unknown, value: unknown) => ({ operator: 'gt', column, value })),
  searchIndexedPostIds: vi.fn(),
  requireLocalNodeNsfwClassification: vi.fn(),
  authorizeFederationRead: vi.fn(),
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
        swarmContentClock: { findFirst: vi.fn().mockResolvedValue({ sequence: 100 }) },
      },
    },
    posts: columns,
    users: columns,
    media: columns,
    remoteReposts: columns,
    feedStories: columns,
    swarmPostChanges: columns,
    swarmAccountTombstones: columns,
  };
});

vi.mock('drizzle-orm', () => {
  const expression = (operator: string) => (...values: unknown[]) => ({ operator, values });
  const sql = () => ({ mapWith: () => ({ operator: 'mappedSql' }) });

  return {
    eq: expression('eq'),
    asc: expression('asc'),
    desc: expression('desc'),
    gt: mocks.gt,
    and: mocks.and,
    isNull: expression('isNull'),
    lt: expression('lt'),
    inArray: mocks.inArray,
    notLike: mocks.notLike,
    or: expression('or'),
    sql,
  };
});

vi.mock('@/lib/node/local-node', () => ({
  requireLocalNodeNsfwClassification: mocks.requireLocalNodeNsfwClassification,
}));

vi.mock('@/lib/swarm/signed-read', () => ({
  authorizeFederationRead: mocks.authorizeFederationRead,
  federationReadFailureResponse: (authorization: { status: number; code: string; error: string }) =>
    Response.json({ error: authorization.error, code: authorization.code }, { status: authorization.status }),
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

vi.mock('@/lib/search/post-index', () => ({
  searchIndexedPostIds: mocks.searchIndexedPostIds,
}));

vi.mock('@/lib/swarm/change-bundle', () => ({
  createSignedChangeBundle: vi.fn(async (input) => ({
    bundle: { ...input, type: 'ChangeBundle', version: 1 },
    signature: 'origin-signature',
  })),
}));

import { GET } from './route';

function emptySelectBuilder(rows: unknown[] = []) {
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ['from', 'innerJoin', 'where', 'groupBy', 'orderBy']) {
    builder[method] = vi.fn(() => builder);
  }
  builder.limit = vi.fn().mockResolvedValue(rows);
  return builder;
}

describe('GET /api/swarm/timeline local-author boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'local.example');
    mocks.requireLocalNodeNsfwClassification.mockResolvedValue(false);
    mocks.authorizeFederationRead.mockResolvedValue({ ok: true, sourceDomain: 'peer.example' });
    mocks.searchIndexedPostIds.mockResolvedValue([]);
  });

  it('excludes qualified cached-remote handles from the indexed story query', async () => {
    const storyQuery = emptySelectBuilder();
    mocks.select.mockReturnValueOnce(storyQuery);

    const response = await GET(
      new Request('https://local.example/api/swarm/timeline') as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ posts: [] });
    expect(mocks.notLike).toHaveBeenCalledOnce();
    expect(mocks.notLike).toHaveBeenCalledWith('handle', '%@%');
    expect(storyQuery.where).toHaveBeenCalledOnce();
  });

  it('applies a word-index result to the materialized story query', async () => {
    const storyQuery = emptySelectBuilder();
    mocks.select.mockReturnValueOnce(storyQuery);
    mocks.searchIndexedPostIds.mockResolvedValue(['post-1']);

    const response = await GET(
      new Request('https://local.example/api/swarm/timeline?q=Yolked') as never,
    );

    expect(response.status).toBe(200);
    expect(mocks.searchIndexedPostIds).toHaveBeenCalledWith('local', 'Yolked');
    expect(mocks.inArray).toHaveBeenCalledWith('id', ['post-1']);
    const searchCondition = mocks.inArray.mock.results[0]?.value;
    expect(mocks.and).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      searchCondition,
    );
  });

  it('returns unseen activity oldest-first when a sync bookmark is supplied', async () => {
    const storyQuery = emptySelectBuilder();
    mocks.select.mockReturnValueOnce(storyQuery);

    const response = await GET(new Request(
      'https://local.example/api/swarm/timeline?since=2026-07-18T00%3A00%3A00.000Z&sinceId=post-1',
    ) as never);

    expect(response.status).toBe(200);
    expect(mocks.gt).toHaveBeenCalledWith('latestActivityAt', new Date('2026-07-18T00:00:00.000Z'));
    expect(mocks.gt).toHaveBeenCalledWith('storyId', 'post-1');
    expect(storyQuery.orderBy).toHaveBeenCalledWith(
      { operator: 'asc', values: ['latestActivityAt'] },
      { operator: 'asc', values: ['storyId'] },
    );
  });

  it('returns authenticated deletion tombstones after a change cursor', async () => {
    mocks.select
      .mockReturnValueOnce(emptySelectBuilder([{
        storyId: 'deleted-post',
        sequence: 42,
        changeType: 'delete',
        changedAt: new Date('2026-07-18T01:00:00.000Z'),
      }]))
      .mockReturnValueOnce(emptySelectBuilder());

    const response = await GET(new Request(
      'https://local.example/api/swarm/timeline?changesSince=41',
    ) as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      posts: [],
      changeCursor: 100,
      hasMoreChanges: false,
      changes: [{
        sequence: 42,
        type: 'delete',
        postId: 'deleted-post',
      }],
    });
  });

  it('does not expose the change stream to unauthenticated scrapers', async () => {
    mocks.authorizeFederationRead.mockResolvedValue({
      ok: false, status: 401, code: 'FEDERATION_AUTH_REQUIRED', error: 'Authenticated federation read required',
    });
    const response = await GET(new Request(
      'https://local.example/api/swarm/timeline?changesSince=0',
    ) as never);
    expect(response.status).toBe(401);
  });

  it('returns durable account tombstones after an account cursor', async () => {
    mocks.select
      .mockReturnValueOnce(emptySelectBuilder([{
        handle: 'alice',
        did: 'did:key:alice-deleted-identity',
        sequence: 51,
        deletedAt: new Date('2026-07-18T02:00:00.000Z'),
      }]))
      .mockReturnValueOnce(emptySelectBuilder());

    const response = await GET(new Request(
      'https://local.example/api/swarm/timeline?accountsSince=50',
    ) as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      accountChanges: [{
        sequence: 51,
        handle: 'alice',
        did: 'did:key:alice-deleted-identity',
      }],
      hasMoreAccountChanges: false,
    });
  });

  it('does not expose account tombstones to unauthenticated scrapers', async () => {
    mocks.authorizeFederationRead.mockResolvedValue({
      ok: false, status: 401, code: 'FEDERATION_AUTH_REQUIRED', error: 'Authenticated federation read required',
    });
    const response = await GET(new Request(
      'https://local.example/api/swarm/timeline?accountsSince=0',
    ) as never);
    expect(response.status).toBe(401);
  });
});
