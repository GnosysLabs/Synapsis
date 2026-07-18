import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnectionRequest, createUpload, exchangeAuthorizationCode } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('Stuffbox client', () => {
  it('self-registers the exact callback and uses the canonical identity returned by Stuffbox', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {
      request_id: 'request-1',
      client_id: 'client-1',
      callback_url: 'https://synapsis.test/api/storage/stuffbox/callback',
      authorization_url: 'https://stuffbox.test/connect/request-1',
      expires_at: '2026-07-15T00:10:00Z',
    } }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);

    await expect(createConnectionRequest('https://stuffbox.test/', {
      callbackUrl: 'https://synapsis.test/api/storage/stuffbox/callback',
      codeChallenge: 'challenge',
      state: 'state',
      scopes: ['assets:write'],
      accountLabel: '@alice@synapsis.test',
    })).resolves.toEqual({
      id: 'request-1',
      clientId: 'client-1',
      callbackUrl: 'https://synapsis.test/api/storage/stuffbox/callback',
      authorizationUrl: 'https://stuffbox.test/connect/request-1',
      expiresAt: '2026-07-15T00:10:00Z',
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://stuffbox.test/api/v1/connection-requests');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      registration_mode: 'self_hosted',
      callback_url: 'https://synapsis.test/api/storage/stuffbox/callback',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
      scopes: ['assets:write'],
      state: 'state',
      account_label: '@alice@synapsis.test',
    });
  });

  it.each([
    ['client_id', {
      request_id: 'request-1',
      callback_url: 'https://synapsis.test/api/storage/stuffbox/callback',
      authorization_url: 'https://stuffbox.test/connect/request-1',
      expires_at: '2026-07-15T00:10:00Z',
    }],
    ['callback_url', {
      request_id: 'request-1',
      client_id: 'client-1',
      authorization_url: 'https://stuffbox.test/connect/request-1',
      expires_at: '2026-07-15T00:10:00Z',
    }],
  ])('rejects a connection response missing %s', async (field, data) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(createConnectionRequest('https://stuffbox.test', {
      callbackUrl: 'https://synapsis.test/api/storage/stuffbox/callback',
      codeChallenge: 'challenge',
      state: 'state',
      scopes: ['assets:write'],
    })).rejects.toMatchObject({
      message: `Stuffbox response is missing ${field}`,
      status: 502,
      code: 'invalid_response',
    });
  });

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
      clientId: 'client-1',
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
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://stuffbox.test/api/v1/token');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      grant_type: 'authorization_code',
      client_id: 'client-1',
      code: 'authorization-code',
      code_verifier: 'verifier',
      redirect_uri: 'https://synapsis.test/api/storage/stuffbox/callback',
    });
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
      clientId: 'client-1', code: 'bad', codeVerifier: 'verifier', redirectUri: 'https://synapsis.test/callback',
    })).rejects.toMatchObject({
      message: 'Connection expired', status: 401, code: 'invalid_grant',
    });
  });
});
