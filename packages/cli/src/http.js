import { signAction } from './signing.js';

export class SynapsisApiError extends Error {
  constructor(message, status, code, body) {
    super(message);
    this.name = 'SynapsisApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export function normalizeNodeUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Synapsis node URL must use HTTP or HTTPS');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('Synapsis node URL must use HTTPS unless it is local');
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export async function requestJson(url, init = {}, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: { Accept: 'application/json', ...init.headers },
    });
  } catch (error) {
    throw new SynapsisApiError(`Unable to reach Synapsis: ${error.message}`, 0, 'NETWORK_ERROR');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new SynapsisApiError(
      body.error || `Synapsis request failed (${response.status})`,
      response.status,
      body.code || `HTTP_${response.status}`,
      body,
    );
  }
  return body;
}

export async function signedRequest(profile, path, action, data, fetchImpl = globalThis.fetch) {
  const signedAction = await signAction(profile, action, data);
  return requestJson(`${profile.nodeUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signedAction),
  }, fetchImpl);
}

export function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
