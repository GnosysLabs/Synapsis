import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trusted: vi.fn(),
  select: vi.fn(),
}));

vi.mock('@/lib/swarm/signed-read', () => ({
  isTrustedFederationRead: mocks.trusted,
}));

vi.mock('@/db', () => ({
  db: { select: mocks.select },
  posts: new Proxy({}, { get: (_target, key) => `posts.${String(key)}` }),
  users: new Proxy({}, { get: (_target, key) => `users.${String(key)}` }),
}));

vi.mock('drizzle-orm', () => {
  const expression = (operator: string) => (...values: unknown[]) => ({ operator, values });
  return {
    and: expression('and'),
    eq: expression('eq'),
    inArray: expression('inArray'),
    isNull: expression('isNull'),
    notLike: expression('notLike'),
  };
});

import { GET } from './route';

function selectBuilder(rows: unknown[]) {
  const builder = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn().mockResolvedValue(rows),
  };
  builder.from.mockReturnValue(builder);
  builder.innerJoin.mockReturnValue(builder);
  return builder;
}

describe('GET /api/swarm/posts/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.trusted.mockResolvedValue(true);
  });

  it('returns only available strict-local posts to an authenticated peer', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    mocks.select.mockReturnValue(selectBuilder([{ id }]));
    const response = await GET(new Request(
      `https://local.social/api/swarm/posts/status?ids=${id}`,
    ) as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ availablePostIds: [id] });
  });

  it('rejects unauthenticated and unbounded reconciliation requests', async () => {
    mocks.trusted.mockResolvedValue(false);
    expect((await GET(new Request(
      'https://local.social/api/swarm/posts/status?ids=11111111-1111-4111-8111-111111111111',
    ) as never)).status).toBe(401);

    mocks.trusted.mockResolvedValue(true);
    const ids = Array.from({ length: 51 }, (_, index) => (
      `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`
    )).join(',');
    expect((await GET(new Request(
      `https://local.social/api/swarm/posts/status?ids=${ids}`,
    ) as never)).status).toBe(400);
  });
});
