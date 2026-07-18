import type {
  StuffboxAsset,
  StuffboxScope,
  StuffboxTokenSet,
  StuffboxUploadSession,
} from './types';

type JsonObject = Record<string, unknown>;

export class StuffboxApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'StuffboxApiError';
  }
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StuffboxApiError('Stuffbox returned an invalid response', 502, 'invalid_response');
  }
  const record = value as JsonObject;
  return record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? record.data as JsonObject
    : record;
}

function string(record: JsonObject, ...keys: string[]): string {
  for (const key of keys) {
    if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  }
  throw new StuffboxApiError(`Stuffbox response is missing ${keys[0]}`, 502, 'invalid_response');
}

function number(record: JsonObject, ...keys: string[]): number {
  for (const key of keys) {
    if (typeof record[key] === 'number' && Number.isFinite(record[key])) return record[key] as number;
  }
  throw new StuffboxApiError(`Stuffbox response is missing ${keys[0]}`, 502, 'invalid_response');
}

function optionalString(record: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  return undefined;
}

function parseScopes(value: unknown): StuffboxScope[] {
  const scopes = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\s+/).filter(Boolean)
      : [];
  return scopes.filter((scope): scope is StuffboxScope =>
    scope === 'assets:read' || scope === 'assets:write' || scope === 'assets:delete');
}

async function request(baseUrl: string, path: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: { Accept: 'application/json', ...init.headers },
      cache: 'no-store',
    });
  } catch (cause) {
    throw new StuffboxApiError(
      cause instanceof Error ? `Unable to reach Stuffbox: ${cause.message}` : 'Unable to reach Stuffbox',
      502,
      'network_error',
    );
  }

  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    const root = body && typeof body === 'object' ? body as JsonObject : {};
    const error = root.error && typeof root.error === 'object' ? root.error as JsonObject : root;
    throw new StuffboxApiError(
      typeof error.message === 'string' ? error.message : `Stuffbox request failed (${response.status})`,
      response.status,
      typeof error.code === 'string' ? error.code : `http_${response.status}`,
    );
  }
  return body;
}

export function configuredStuffboxUrl(): string | null {
  const value = process.env.STUFFBOX_URL?.trim();
  if (!value) return null;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('STUFFBOX_URL must use HTTP or HTTPS');
  return url.toString().replace(/\/$/, '');
}

export async function createConnectionRequest(baseUrl: string, input: {
  callbackUrl: string;
  codeChallenge: string;
  state: string;
  scopes: readonly StuffboxScope[];
  accountLabel?: string;
}): Promise<{
  id: string;
  clientId: string;
  callbackUrl: string;
  authorizationUrl: string;
  expiresAt: string;
}> {
  const accountLabel = input.accountLabel?.trim();
  const data = object(await request(baseUrl, '/api/v1/connection-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      registration_mode: 'self_hosted',
      callback_url: input.callbackUrl,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      scopes: input.scopes,
      state: input.state,
      ...(accountLabel ? { account_label: accountLabel } : {}),
    }),
  }));
  return {
    id: string(data, 'id', 'request_id'),
    clientId: string(data, 'client_id'),
    callbackUrl: string(data, 'callback_url'),
    authorizationUrl: string(data, 'authorizationUrl', 'authorization_url'),
    expiresAt: string(data, 'expiresAt', 'expires_at'),
  };
}

export async function exchangeAuthorizationCode(baseUrl: string, input: {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<StuffboxTokenSet> {
  return parseTokenSet(await request(baseUrl, '/api/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    }),
  }));
}

export async function refreshTokens(baseUrl: string, refreshToken: string): Promise<StuffboxTokenSet> {
  return parseTokenSet(await request(baseUrl, '/api/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  }));
}

function parseTokenSet(value: unknown): StuffboxTokenSet {
  const data = object(value);
  const refreshTokenExpiresIn = data.refresh_token_expires_in ?? data.refreshTokenExpiresIn;
  return {
    accessToken: string(data, 'accessToken', 'access_token'),
    refreshToken: string(data, 'refreshToken', 'refresh_token'),
    expiresIn: number(data, 'expiresIn', 'expires_in'),
    ...(typeof refreshTokenExpiresIn === 'number' ? { refreshTokenExpiresIn } : {}),
    scopes: parseScopes(data.scopes ?? data.scope),
  };
}

export async function revokeToken(baseUrl: string, token: string): Promise<void> {
  await request(baseUrl, '/api/v1/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, token_type_hint: 'refresh_token' }),
  });
}

export async function createUpload(baseUrl: string, accessToken: string, input: {
  filename: string;
  mimeType: string;
  size: number;
  sha256?: string;
}): Promise<StuffboxUploadSession> {
  const data = object(await request(baseUrl, '/api/v1/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      filename: input.filename,
      mime_type: input.mimeType,
      size: input.size,
      ...(input.sha256 ? { sha256: input.sha256 } : {}),
    }),
  }));
  const headers = data.requiredHeaders ?? data.required_headers ?? {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new StuffboxApiError('Stuffbox returned invalid upload headers', 502, 'invalid_response');
  }
  return {
    id: string(data, 'id', 'upload_id'),
    uploadUrl: string(data, 'uploadUrl', 'upload_url'),
    method: 'PUT',
    requiredHeaders: Object.fromEntries(
      Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
    expiresAt: string(data, 'expiresAt', 'expires_at'),
  };
}

export async function completeUpload(
  baseUrl: string,
  accessToken: string,
  uploadId: string,
): Promise<StuffboxAsset> {
  const data = object(await request(baseUrl, `/api/v1/uploads/${encodeURIComponent(uploadId)}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: '{}',
  }));
  const asset = data.asset && typeof data.asset === 'object' ? data.asset as JsonObject : data;
  const status = optionalString(asset, 'status') ?? 'active';
  if (status !== 'active' && status !== 'deleting' && status !== 'deleted') {
    throw new StuffboxApiError('Stuffbox returned an invalid asset status', 502, 'invalid_response');
  }
  return {
    id: string(asset, 'id', 'asset_id'),
    publicId: string(asset, 'publicId', 'public_id'),
    url: string(asset, 'url', 'canonical_url'),
    filename: string(asset, 'filename', 'original_filename'),
    mimeType: string(asset, 'mimeType', 'mime_type'),
    byteSize: number(asset, 'byteSize', 'byte_size'),
    ...(optionalString(asset, 'sha256') ? { sha256: optionalString(asset, 'sha256') } : {}),
    status,
    createdAt: string(asset, 'createdAt', 'created_at'),
    ...(optionalString(asset, 'deletedAt', 'deleted_at')
      ? { deletedAt: optionalString(asset, 'deletedAt', 'deleted_at') }
      : {}),
  };
}
