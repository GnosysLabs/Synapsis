import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { exchangeAuthorizationCode } from '@/lib/stuffbox/client';
import { consumeStuffboxConnectionState } from '@/lib/stuffbox/connection-state';
import { renderStuffboxPopupResponse } from '@/lib/stuffbox/popup-response';
import { saveStuffboxTokens } from '@/lib/stuffbox/tokens';
import { GET } from './route';
import { getOrRefreshStuffboxBadge } from '@/lib/stuffbox/badge-status';

vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));

vi.mock('@/lib/stuffbox/client', () => {
  class MockStuffboxApiError extends Error {}

  return {
    exchangeAuthorizationCode: vi.fn(),
    StuffboxApiError: MockStuffboxApiError,
  };
});

vi.mock('@/lib/stuffbox/connection-state', () => ({ consumeStuffboxConnectionState: vi.fn() }));
vi.mock('@/lib/stuffbox/popup-response', () => ({ renderStuffboxPopupResponse: vi.fn() }));
vi.mock('@/lib/stuffbox/tokens', () => ({ saveStuffboxTokens: vi.fn() }));
vi.mock('@/lib/stuffbox/badge-status', () => ({ getOrRefreshStuffboxBadge: vi.fn() }));

describe('GET /api/storage/stuffbox/callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAuth).mockResolvedValue({ id: 'user-1', handle: 'alice@synapsis.example' } as never);
    vi.mocked(consumeStuffboxConnectionState).mockResolvedValue({
      userId: 'user-1',
      baseUrl: 'https://stuffbox.example',
      clientId: 'client-returned-by-stuffbox',
      verifier: 'pkce-verifier',
      state: 'connection-state',
      callbackUrl: 'https://canonical.synapsis.example/api/storage/stuffbox/callback',
      expiresAt: Date.now() + 60_000,
    });
    vi.mocked(exchangeAuthorizationCode).mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 900,
      scopes: ['assets:write'],
    });
    vi.mocked(saveStuffboxTokens).mockResolvedValue(undefined);
    vi.mocked(getOrRefreshStuffboxBadge).mockResolvedValue(null);
    vi.mocked(renderStuffboxPopupResponse).mockReturnValue('<html>connected</html>');
  });

  it('exchanges the code with the same client ID and callback saved at connect time', async () => {
    const response = await GET(new NextRequest(
      'https://synapsis.example/api/storage/stuffbox/callback?code=authorization-code&state=connection-state',
    ));

    expect(response.status).toBe(200);
    expect(exchangeAuthorizationCode).toHaveBeenCalledWith('https://stuffbox.example', {
      clientId: 'client-returned-by-stuffbox',
      code: 'authorization-code',
      codeVerifier: 'pkce-verifier',
      redirectUri: 'https://canonical.synapsis.example/api/storage/stuffbox/callback',
    });
    expect(saveStuffboxTokens).toHaveBeenCalledWith('user-1', 'https://stuffbox.example', {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 900,
      scopes: ['assets:write'],
    });
    expect(getOrRefreshStuffboxBadge).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1', handle: 'alice@synapsis.example' }),
      { force: true },
    );
    expect(renderStuffboxPopupResponse).toHaveBeenCalledWith(
      'https://canonical.synapsis.example',
      true,
      'Stuffbox connected.',
      'connection-state',
    );
  });
});
