import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUpload, exchangeAuthorizationCode } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('Stuffbox client', () => {
  it('exchanges an authorization code and accepts the v1 snake-case response', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 900,
      refresh_token_expires_in: 2_592_000,
      scope: 'assets:read assets:write',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);

    const tokens = await exchangeAuthorizationCode('https://stuffbox.test/', {
      code: 'authorization-code',
      codeVerifier: 'verifier',
      redirectUri: 'https://synapsis.test/api/storage/stuffbox/callback',
    });

    expect(tokens).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 900,
      refreshTokenExpiresIn: 2_592_000,
      scopes: ['assets:read', 'assets:write'],
    });
    expect(fetch).toHaveBeenCalledWith('https://stuffbox.test/api/v1/token', expect.objectContaining({ method: 'POST' }));
  });

  it('normalizes a direct upload session without exposing the bearer token to the browser response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {
      upload_id: 'upload-1',
      upload_url: 'https://objects.test/upload-1',
      required_headers: { 'Content-Type': 'image/png', 'x-upload-token': 'one-time' },
      expires_at: '2026-07-15T00:00:00Z',
    } }), { status: 201, headers: { 'Content-Type': 'application/json' } })));

    await expect(createUpload('https://stuffbox.test', 'secret-access-token', {
      filename: 'photo.png', mimeType: 'image/png', size: 123,
    })).resolves.toEqual({
      id: 'upload-1',
      uploadUrl: 'https://objects.test/upload-1',
      method: 'PUT',
      requiredHeaders: { 'Content-Type': 'image/png', 'x-upload-token': 'one-time' },
      expiresAt: '2026-07-15T00:00:00Z',
    });
  });

  it('preserves structured Stuffbox errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'invalid_grant', message: 'Connection expired' },
    }), { status: 401, headers: { 'Content-Type': 'application/json' } })));

    await expect(exchangeAuthorizationCode('https://stuffbox.test', {
      code: 'bad', codeVerifier: 'verifier', redirectUri: 'https://synapsis.test/callback',
    })).rejects.toMatchObject({
      message: 'Connection expired', status: 401, code: 'invalid_grant',
    });
  });
});
