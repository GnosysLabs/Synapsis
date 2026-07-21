import { createSign, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  findTombstone: vi.fn(),
  findFollows: vi.fn(),
  transaction: vi.fn(),
  inserted: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  deleted: [] as unknown[],
  tables: {
    users: { table: 'users' },
    chatConversations: { table: 'chatConversations' },
    chatMessages: { table: 'chatMessages' },
    follows: { table: 'follows' },
    handleRegistry: { table: 'handleRegistry' },
    likes: { table: 'likes' },
    notifications: { table: 'notifications' },
    posts: { table: 'posts' },
    reports: { table: 'reports' },
    sessions: { table: 'sessions' },
    swarmAccountTombstones: { table: 'swarmAccountTombstones' },
    swarmContentClock: { table: 'swarmContentClock' },
  },
}));

vi.mock('@/db', () => ({
  ...mocks.tables,
  db: {
    query: {
      users: { findFirst: mocks.findUser },
      swarmAccountTombstones: { findFirst: mocks.findTombstone },
      follows: { findMany: mocks.findFollows },
    },
    transaction: mocks.transaction,
  },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  or: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
}));

import { POST } from './route';

function request(body: unknown): Request {
  return new Request('https://old.example/api/account/moved', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/account/moved', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'old.example');
    mocks.inserted.length = 0;
    mocks.deleted.length = 0;
    mocks.findTombstone.mockResolvedValue(undefined);
    mocks.findFollows.mockResolvedValue([]);
    const settled = () => Object.assign(Promise.resolve(), {
      returning: vi.fn(async () => [{ sequence: 41 }]),
    });
    const tx = {
      query: { chatConversations: { findMany: vi.fn(async () => []) } },
      delete: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          mocks.deleted.push(table);
          return Promise.resolve();
        }),
      })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(settled) })) })),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn((values: Record<string, unknown>) => {
          mocks.inserted.push({ table, values });
          return Promise.resolve();
        }),
      })),
    };
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects future-dated move notifications before touching account state', async () => {
    const response = await POST(request({
      oldHandle: 'alice',
      newActorUrl: 'https://new.social/users/alice',
      did: 'did:key:zAccountIdentity',
      movedAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      signature: 'YQ==',
    }) as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Move notification timestamp is invalid' });
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

  it('atomically deletes source data and leaves a permanent move tombstone', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const movedAt = new Date().toISOString();
    const payload = {
      oldHandle: 'alice',
      newActorUrl: 'https://new.social/users/alice',
      did: 'did:key:zAccountIdentity',
      movedAt,
    };
    const signer = createSign('sha256');
    signer.update(JSON.stringify(payload));
    mocks.findUser.mockResolvedValue({
      id: 'user-1',
      did: payload.did,
      handle: 'alice@old.example',
      username: 'alice',
      publicKey,
    });

    const response = await POST(request({
      ...payload,
      signature: signer.sign(privateKey, 'base64'),
    }) as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sourceDataDeleted: true,
      usernameReserved: true,
    });
    expect(mocks.inserted).toContainEqual({
      table: mocks.tables.swarmAccountTombstones,
      values: expect.objectContaining({
        handle: 'alice@old.example',
        did: payload.did,
        movedTo: payload.newActorUrl,
      }),
    });
    expect(mocks.deleted).toContain(mocks.tables.users);
  });
});
