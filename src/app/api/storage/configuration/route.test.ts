import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  configuredStuffboxUrl: vi.fn(),
  getStuffboxConnection: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/stuffbox/client', () => ({ configuredStuffboxUrl: mocks.configuredStuffboxUrl }));
vi.mock('@/lib/stuffbox/tokens', () => ({ getStuffboxConnection: mocks.getStuffboxConnection }));

import { GET } from './route';

describe('GET /api/storage/configuration', () => {
  beforeEach(() => {
    mocks.requireAuth.mockReset();
    mocks.configuredStuffboxUrl.mockReset();
    mocks.getStuffboxConnection.mockReset();
    mocks.configuredStuffboxUrl.mockReturnValue('https://stuffbox.example');
    mocks.getStuffboxConnection.mockResolvedValue(null);
  });

  it('does not expose legacy S3 credentials as an active storage provider', async () => {
    mocks.requireAuth.mockResolvedValue({
      id: 'user-1',
      storageProvider: 's3',
      storageBucket: 'legacy-bucket',
    });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      provider: null,
      stuffboxAvailable: true,
      stuffboxBaseUrl: null,
      stuffboxUpdatedAt: null,
    });
  });
});
