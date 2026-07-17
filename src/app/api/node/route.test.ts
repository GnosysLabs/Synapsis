import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findMany: vi.fn(),
  getNodePublicKey: vi.fn(),
  getVersionedNodeAssetUrl: vi.fn(),
  getSensitiveContentViewerAccess: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: {
    query: {
      nodes: {
        findFirst: mocks.findFirst,
        findMany: mocks.findMany,
      },
    },
    select: vi.fn(),
  },
  users: {
    handle: 'handle',
    displayName: 'displayName',
    avatarUrl: 'avatarUrl',
    isNsfw: 'isNsfw',
    email: 'email',
  },
}));

vi.mock('@/lib/swarm/node-keys', () => ({
  getNodePublicKey: mocks.getNodePublicKey,
}));

vi.mock('@/lib/node/assets', () => ({
  getVersionedNodeAssetUrl: mocks.getVersionedNodeAssetUrl,
}));

vi.mock('@/lib/nsfw/viewer-access', () => ({
  getSensitiveContentViewerAccess: mocks.getSensitiveContentViewerAccess,
}));

vi.mock('@/lib/nsfw/content-visibility', () => ({
  redactSensitiveUserSummary: vi.fn((user) => user),
}));

import { GET } from './route';

describe('GET /api/node public response', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'adult.example');
    vi.stubEnv('ADMIN_EMAILS', '');
    mocks.findMany.mockResolvedValue([]);
    mocks.getNodePublicKey.mockResolvedValue('PUBLIC KEY');
    mocks.getVersionedNodeAssetUrl.mockImplementation((path: string) => `${path}?v=1`);
    mocks.getSensitiveContentViewerAccess.mockResolvedValue({
      localNodeIsNsfw: true,
      canViewSensitive: false,
    });
  });

  it('omits private fields, keeps adult node identity public, and hides only the banner', async () => {
    mocks.findFirst.mockResolvedValue({
      id: 'internal-node-id',
      domain: 'adult.example',
      name: 'Adult node',
      description: 'Description',
      longDescription: 'Long description',
      rules: 'Rules',
      bannerUrl: 'https://adult.example/private-banner.jpg',
      logoUrl: 'https://adult.example/old-logo.jpg',
      faviconUrl: 'https://adult.example/old-favicon.ico',
      logoData: 'RAW SECRET LOGO DATA',
      faviconData: 'RAW SECRET FAVICON DATA',
      accentColor: '#123456',
      publicKey: 'STALE PUBLIC KEY',
      privateKeyEncrypted: 'PRIVATE KEY MATERIAL',
      isNsfw: true,
      turnstileSiteKey: 'site-key',
      turnstileSecretKey: 'TURNSTILE SECRET',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-17T00:00:00.000Z'),
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      domain: 'adult.example',
      name: 'Adult node',
      description: 'Description',
      longDescription: 'Long description',
      rules: 'Rules',
      bannerUrl: null,
      logoUrl: '/api/node/logo?v=1',
      faviconUrl: '/api/node/favicon?v=1',
      accentColor: '#123456',
      publicKey: 'PUBLIC KEY',
      isNsfw: true,
      turnstileSiteKey: 'site-key',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z',
      admins: [],
    });

    const serialized = JSON.stringify(body);
    for (const secret of [
      'RAW SECRET LOGO DATA',
      'RAW SECRET FAVICON DATA',
      'PRIVATE KEY MATERIAL',
      'TURNSTILE SECRET',
      'internal-node-id',
      'private-banner.jpg',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('returns derived safe-node asset routes without returning their raw data', async () => {
    mocks.getSensitiveContentViewerAccess.mockResolvedValue({
      localNodeIsNsfw: false,
      canViewSensitive: false,
    });
    mocks.findFirst.mockResolvedValue({
      id: 'node-1',
      domain: 'adult.example',
      name: 'Safe node',
      description: null,
      longDescription: null,
      rules: null,
      bannerUrl: null,
      logoUrl: null,
      faviconUrl: null,
      logoData: 'RAW LOGO',
      faviconData: 'RAW FAVICON',
      accentColor: '#FFFFFF',
      publicKey: null,
      privateKeyEncrypted: null,
      isNsfw: false,
      turnstileSiteKey: null,
      turnstileSecretKey: null,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-17T00:00:00.000Z'),
    });

    const body = await (await GET()).json();

    expect(body.logoUrl).toBe('/api/node/logo?v=1');
    expect(body.faviconUrl).toBe('/api/node/favicon?v=1');
    expect(body).not.toHaveProperty('logoData');
    expect(body).not.toHaveProperty('faviconData');
  });
});
