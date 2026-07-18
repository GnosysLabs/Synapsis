import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { configuredStuffboxUrl, createConnectionRequest } from '@/lib/stuffbox/client';
import { saveStuffboxConnectionState } from '@/lib/stuffbox/connection-state';
import { generatePkce } from '@/lib/stuffbox/crypto';
import { POST } from './route';

vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));

vi.mock('@/lib/stuffbox/client', () => {
  class MockStuffboxApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code: string,
    ) {
      super(message);
    }
  }

  return {
    configuredStuffboxUrl: vi.fn(),
    createConnectionRequest: vi.fn(),
    StuffboxApiError: MockStuffboxApiError,
  };
});

vi.mock('@/lib/stuffbox/connection-state', () => ({ saveStuffboxConnectionState: vi.fn() }));
vi.mock('@/lib/stuffbox/crypto', () => ({ generatePkce: vi.fn() }));

describe('POST /api/storage/stuffbox/connect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T01:00:00.000Z'));
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://synapsis.example/app');
    vi.mocked(requireAuth).mockResolvedValue({ id: 'user-1', handle: 'alice' } as never);
    vi.mocked(configuredStuffboxUrl).mockReturnValue('https://stuffbox.example');
    vi.mocked(generatePkce).mockReturnValue({
      challenge: 'pkce-challenge',
      verifier: 'pkce-verifier',
      state: 'connection-state',
    });
    vi.mocked(createConnectionRequest).mockResolvedValue({
      id: 'request-1',
      clientId: 'client-returned-by-stuffbox',
      callbackUrl: 'https://canonical.synapsis.example/api/storage/stuffbox/callback',
      authorizationUrl: 'https://stuffbox.example/connect/request-1',
      expiresAt: '2026-07-15T01:05:00.000Z',
    });
    vi.mocked(saveStuffboxConnectionState).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('persists the client ID and canonical callback returned by Stuffbox', async () => {
    const response = await POST(new NextRequest('https://synapsis.example/api/storage/stuffbox/connect', {
      method: 'POST',
    }));

    expect(response.status).toBe(200);
    expect(createConnectionRequest).toHaveBeenCalledWith('https://stuffbox.example', {
      callbackUrl: 'https://synapsis.example/api/storage/stuffbox/callback',
      codeChallenge: 'pkce-challenge',
      state: 'connection-state',
      scopes: ['assets:write'],
      accountLabel: '@alice@synapsis.example',
    });
    expect(saveStuffboxConnectionState).toHaveBeenCalledWith({
      userId: 'user-1',
      baseUrl: 'https://stuffbox.example',
      clientId: 'client-returned-by-stuffbox',
      verifier: 'pkce-verifier',
      state: 'connection-state',
      callbackUrl: 'https://canonical.synapsis.example/api/storage/stuffbox/callback',
      expiresAt: Date.parse('2026-07-15T01:05:00.000Z'),
    });
    await expect(response.json()).resolves.toMatchObject({
      authorizationUrl: 'https://stuffbox.example/connect/request-1',
      connectionAttempt: 'connection-state',
    });
  });
});
