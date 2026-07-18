import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  select: vi.fn(),
  from: vi.fn(),
  innerJoin: vi.fn(),
  where: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ getSession: mocks.getSession }));

vi.mock('@/db', async () => {
  const schema = await vi.importActual<typeof import('@/db/schema')>('@/db/schema');
  return {
    ...schema,
    db: { select: mocks.select },
  };
});

import { GET } from './route';

describe('GET /api/chat/unread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
      user: { id: 'owner-id', handle: 'owner' },
    });
    mocks.select.mockReturnValue({ from: mocks.from });
    mocks.from.mockReturnValue({ innerJoin: mocks.innerJoin });
    mocks.innerJoin.mockReturnValue({ where: mocks.where });
    mocks.where.mockResolvedValue([{ unreadCount: 42 }]);
  });

  it('returns one database aggregate instead of materializing conversations and messages', async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ unreadCount: 42 });
    expect(mocks.select).toHaveBeenCalledOnce();
    expect(mocks.from).toHaveBeenCalledOnce();
    expect(mocks.innerJoin).toHaveBeenCalledOnce();
    expect(mocks.where).toHaveBeenCalledOnce();
  });
});
