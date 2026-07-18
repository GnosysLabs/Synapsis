import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({
  db: {
    query: { users: { findFirst: vi.fn() } },
    update: vi.fn(),
  },
  users: { id: 'id' },
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn(() => ({})) }));

import { POST } from './route';

function request(body: unknown): Request {
  return new Request('https://old.example/api/account/moved', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/account/moved', () => {
  it('rejects stale signed move notifications before touching account state', async () => {
    const response = await POST(request({
      oldHandle: 'alice',
      newActorUrl: 'https://new.social/users/alice',
      did: 'did:key:zAccountIdentity',
      movedAt: '2025-01-01T00:00:00.000Z',
      signature: 'YQ==',
    }) as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Move notification is stale' });
  });

  it('rejects oversized bodies without buffering an unrestricted request', async () => {
    const response = await POST(request({ padding: 'x'.repeat(40 * 1024) }) as never);

    expect(response.status).toBe(413);
  });

  it('rejects private or credential-bearing destination URLs', async () => {
    const response = await POST(request({
      oldHandle: 'alice',
      newActorUrl: 'https://user:secret@localhost/users/alice',
      did: 'did:key:zAccountIdentity',
      movedAt: new Date().toISOString(),
      signature: 'YQ==',
    }) as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid move notification' });
  });
});
