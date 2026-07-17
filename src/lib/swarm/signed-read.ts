import crypto from 'crypto';
import { normalizeNodeDomain, getPublicSwarmDomain } from './node-domain';
import {
  safeFederationRequest,
  type SafeFederationRequestOptions,
  type SafeFederationResponse,
} from './safe-federation-http';
import { getNodePrivateKey, signPayload, verifySignature } from './signature';
import { getNodePublicKey as getLocalNodePublicKey } from './node-keys';
import { getTrustedSwarmReadPeerPublicKey } from './registry';

const READ_SIGNATURE_MAX_AGE_MS = 2 * 60 * 1000;
const DEVELOPMENT_LOOPBACK_DOMAIN = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

const SOURCE_HEADER = 'X-Swarm-Read-Source';
const TARGET_HEADER = 'X-Swarm-Read-Target';
const TIMESTAMP_HEADER = 'X-Swarm-Read-Timestamp';
const SIGNATURE_HEADER = 'X-Swarm-Read-Signature';
const NONCE_HEADER = 'X-Swarm-Read-Nonce';
const MAX_TRACKED_READ_NONCES = 10_000;
const consumedReadNonces = new Map<string, number>();

interface SignedReadPayload {
  method: 'GET';
  path: string;
  sourceDomain: string;
  targetDomain: string;
  timestamp: number;
  nonce: string;
}

type SignedReadOptions = Omit<SafeFederationRequestOptions, 'method' | 'body'>;

function developmentDomain(value: string): string | null {
  const normalized = normalizeNodeDomain(value);
  return process.env.NODE_ENV === 'development' && DEVELOPMENT_LOOPBACK_DOMAIN.test(normalized)
    ? normalized
    : null;
}

function federationIdentity(value: string | null | undefined): string | null {
  if (!value) return null;
  return getPublicSwarmDomain(value) ?? developmentDomain(value);
}

function signedReadPayload(
  url: URL,
  sourceDomain: string,
  targetDomain: string,
  timestamp: number,
  nonce: string,
): SignedReadPayload {
  return {
    method: 'GET',
    path: `${url.pathname}${url.search}`,
    sourceDomain,
    targetDomain,
    timestamp,
    nonce,
  };
}

function consumeReadNonce(sourceDomain: string, nonce: string, now: number): boolean {
  for (const [key, expiresAt] of consumedReadNonces) {
    if (expiresAt <= now) consumedReadNonces.delete(key);
  }

  const key = `${sourceDomain}:${nonce}`;
  if (consumedReadNonces.has(key)) return false;
  if (consumedReadNonces.size >= MAX_TRACKED_READ_NONCES) {
    const oldestKey = consumedReadNonces.keys().next().value as string | undefined;
    if (oldestKey) consumedReadNonces.delete(oldestKey);
  }
  consumedReadNonces.set(key, now + READ_SIGNATURE_MAX_AGE_MS);
  return true;
}

/**
 * Make an SSRF-safe federation GET and prove the request came from this node.
 * If local node identity/keys are unavailable, the request remains unsigned;
 * upgraded peers then return only their public, redacted representation.
 */
export async function signedFederationRead(
  input: string,
  options: SignedReadOptions = {},
): Promise<SafeFederationResponse> {
  const url = new URL(input);
  const sourceDomain = federationIdentity(process.env.NEXT_PUBLIC_NODE_DOMAIN);
  const targetDomain = federationIdentity(url.host);
  const headers: Record<string, string | readonly string[] | undefined> = {
    ...options.headers,
  };

  if (sourceDomain && targetDomain) {
    try {
      const timestamp = Date.now();
      const nonce = crypto.randomUUID();
      const payload = signedReadPayload(url, sourceDomain, targetDomain, timestamp, nonce);
      const signature = signPayload(payload, await getNodePrivateKey());
      headers[SOURCE_HEADER] = sourceDomain;
      headers[TARGET_HEADER] = targetDomain;
      headers[TIMESTAMP_HEADER] = String(timestamp);
      headers[NONCE_HEADER] = nonce;
      headers[SIGNATURE_HEADER] = signature;
    } catch (error) {
      console.warn('[Swarm] Could not sign federation read; requesting public redacted data', error);
    }
  }

  return safeFederationRequest(url.toString(), {
    ...options,
    method: 'GET',
    headers,
  });
}

/** True only for a fresh GET signed by another node for this exact route. */
export async function isTrustedFederationRead(request: Request): Promise<boolean> {
  if (request.method !== 'GET') return false;
  const sourceDomain = federationIdentity(request.headers.get(SOURCE_HEADER));
  const targetDomain = federationIdentity(request.headers.get(TARGET_HEADER));
  const signature = request.headers.get(SIGNATURE_HEADER);
  const timestampValue = request.headers.get(TIMESTAMP_HEADER);
  const nonce = request.headers.get(NONCE_HEADER);
  const expectedTarget = federationIdentity(process.env.NEXT_PUBLIC_NODE_DOMAIN);
  if (!sourceDomain || !targetDomain || !expectedTarget || targetDomain !== expectedTarget
    || !signature || !timestampValue || !nonce
    || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    return false;
  }

  const timestamp = Number(timestampValue);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > READ_SIGNATURE_MAX_AGE_MS) {
    return false;
  }
  const url = new URL(request.url);
  const payload = signedReadPayload(url, sourceDomain, targetDomain, timestamp, nonce);
  let validSignature = false;
  if (sourceDomain === targetDomain) {
    const publicKey = await getLocalNodePublicKey();
    validSignature = Boolean(publicKey && verifySignature(payload, signature, publicKey));
  } else {
    const pinnedPublicKey = await getTrustedSwarmReadPeerPublicKey(sourceDomain);
    validSignature = Boolean(
      pinnedPublicKey
      && verifySignature(payload, signature, pinnedPublicKey),
    );
  }
  return validSignature && consumeReadNonce(sourceDomain, nonce, Date.now());
}
