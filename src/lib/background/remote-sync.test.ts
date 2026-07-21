import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  candidates: [] as Array<{ targetHandle: string; nodeDomain: string }>,
  run: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
  findState: vi.fn(),
  returning: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  isSwarmNode: vi.fn(),
  cacheSwarmUserPosts: vi.fn(),
}));

function selectedRows() {
  const builder = {
    from: vi.fn(), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn(),
  };
  builder.from.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  builder.orderBy.mockReturnValue(builder);
  builder.limit.mockImplementation(async (limit: number) => mocks.candidates.slice(0, limit));
  return builder;
}

vi.mock('@/db', () => {
  const columns = new Proxy({}, { get: (_target, property) => String(property) });
  return {
    db: {
      run: mocks.run,
      select: mocks.select,
      update: mocks.update,
      query: { remoteFollowSyncStates: { findFirst: mocks.findState } },
    },
    remoteFollowSyncStates: columns,
    swarmNodes: columns,
  };
});

vi.mock('drizzle-orm', () => {
  const expression = (...values: unknown[]) => values;
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values });
  sql.identifier = (name: string) => ({ identifier: name });
  return { and: expression, asc: expression, eq: expression, isNull: expression, lte: expression, or: expression, sql };
});

vi.mock('@/lib/swarm/interactions', () => ({
  isSwarmNode: mocks.isSwarmNode,
  cacheSwarmUserPosts: mocks.cacheSwarmUserPosts,
}));

import { clearSyncCache, seedFollowSyncStates, syncRemoteFollowsPosts } from './remote-sync';

function targets(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    targetHandle: `user${index}@node${index}.social`,
    nodeDomain: `node${index}.social`,
  }));
}

describe('durable remote follow synchronization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSyncCache();
    mocks.candidates = [];
    mocks.run.mockResolvedValue(undefined);
    mocks.select.mockImplementation(selectedRows);
    mocks.returning.mockImplementation(async () => [{ targetHandle: 'claimed' }]);
    const updateBuilder = { set: mocks.set };
    const setBuilder = { where: mocks.where };
    const whereResult = {
      returning: mocks.returning,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
    };
    mocks.update.mockReturnValue(updateBuilder);
    mocks.set.mockReturnValue(setBuilder);
    mocks.where.mockReturnValue(whereResult);
    mocks.findState.mockResolvedValue({ failures: 0, lastSuccessAt: null });
    mocks.isSwarmNode.mockResolvedValue(true);
    mocks.cacheSwarmUserPosts.mockResolvedValue({ cached: 1, skipped: 0, success: true });
  });

  it('shares one in-flight run between overlapping scheduler calls', async () => {
    mocks.candidates = targets(1);
    let release!: (value: { cached: number; skipped: number; success: boolean }) => void;
    mocks.cacheSwarmUserPosts.mockImplementation(() => new Promise((resolve) => { release = resolve; }));

    const first = syncRemoteFollowsPosts('https://local.social');
    const second = syncRemoteFollowsPosts('https://local.social');
    expect(second).toBe(first);
    await vi.waitFor(() => expect(mocks.cacheSwarmUserPosts).toHaveBeenCalledOnce());
    release({ cached: 1, skipped: 0, success: true });
    await first;
  });

  it('claims no more than twenty targets per run', async () => {
    mocks.candidates = targets(30);
    const result = await syncRemoteFollowsPosts('https://local.social');
    expect(result.synced).toBe(20);
    expect(mocks.cacheSwarmUserPosts).toHaveBeenCalledTimes(20);
  });

  it('records a failed refresh without aborting the batch', async () => {
    mocks.candidates = targets(1);
    mocks.cacheSwarmUserPosts.mockResolvedValue({ cached: 0, skipped: 0, success: false });
    const result = await syncRemoteFollowsPosts('https://local.social');
    expect(result).toMatchObject({ synced: 0, errors: 1 });
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({ failures: 1 }));
  });

  it('durably schedules remote actors referenced by notifications', async () => {
    await seedFollowSyncStates();

    expect(mocks.run).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(mocks.run.mock.calls[1]?.[0])).toContain('notifications');
  });
});
