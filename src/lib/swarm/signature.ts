/**
 * Swarm Signature Verification
 * 
 * Cryptographic signatures for all swarm interactions to prevent forgery.
 * Each node signs requests with their private key, and recipients verify
 * using the sender's public key.
 */

import crypto from 'crypto';
import { canonicalize } from '@/lib/crypto/user-signing';
import { isNodeBlocked, normalizeNodeDomain } from './node-blocklist';
import { getPublicSwarmDomain } from './node-domain';
import { safeFederationRequest } from './safe-federation-http';
import { isRateLimited } from '@/lib/rate-limit';
import { getPinnedSwarmNodePublicKey, pinSwarmNodePublicKey } from './registry';

const NODE_PUBLIC_KEY_CACHE_TTL_MS = 60_000;
const MAX_NODE_PUBLIC_KEY_CACHE_ENTRIES = 1_000;
const NODE_PUBLIC_KEY_MAX_RESPONSE_BYTES = 16 * 1024;
// Older nodes expose their key only through /api/node. That document may
// include embedded branding assets, so keep a bounded compatibility fallback
// while new nodes use the deliberately small key-only endpoint.
const LEGACY_NODE_INFO_MAX_RESPONSE_BYTES = 256 * 1024;
const nodePublicKeyCache = new Map<string, { publicKey: string; expiresAt: number }>();
const pendingNodePublicKeyRequests = new Map<string, Promise<string | null>>();
const MAX_CONCURRENT_SWARM_VERIFICATIONS = 32;
let activeSwarmVerifications = 0;

export function isFreshFederationTimestamp(
  value: string | number | Date,
  maximumAgeMs = 5 * 60 * 1_000,
): boolean {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) && Math.abs(Date.now() - timestamp) <= maximumAgeMs;
}

function cacheNodePublicKey(domain: string, publicKey: string): void {
  if (!nodePublicKeyCache.has(domain)
    && nodePublicKeyCache.size >= MAX_NODE_PUBLIC_KEY_CACHE_ENTRIES) {
    const oldest = nodePublicKeyCache.keys().next().value as string | undefined;
    if (oldest) nodePublicKeyCache.delete(oldest);
  }
  nodePublicKeyCache.set(domain, {
    publicKey,
    expiresAt: Date.now() + NODE_PUBLIC_KEY_CACHE_TTL_MS,
  });
}

function normalizeNodePublicKey(publicKey: string): string | null {
  try {
    const key = crypto.createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'ec'
      || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      return null;
    }
    return key.export({ type: 'spki', format: 'pem' }).toString();
  } catch {
    return null;
  }
}

function resolveFederationDomain(domain: string): { domain: string; protocol: 'http' | 'https' } | null {
  const normalized = normalizeNodeDomain(domain);
  const developmentLoopback = process.env.NODE_ENV === 'development'
    && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(normalized);
  if (developmentLoopback) return { domain: normalized, protocol: 'http' };

  const publicDomain = getPublicSwarmDomain(normalized);
  return publicDomain ? { domain: publicDomain, protocol: 'https' } : null;
}

/**
 * Sign a payload with the node's private key
 */
export function signPayload(payload: unknown, privateKey: string): string {
  const canonicalPayload = canonicalize(payload);
  const sign = crypto.createSign('SHA256');
  sign.update(canonicalPayload);
  sign.end();
  return sign.sign(privateKey, 'base64');
}

function normalizePublicKey(publicKey: string): crypto.KeyObject | string {
  if (publicKey.includes('BEGIN PUBLIC KEY')) {
    return publicKey;
  }

  const cleanKey = publicKey.replace(/[\s\n\r]/g, '');
  return crypto.createPublicKey({
    key: Buffer.from(cleanKey, 'base64'),
    format: 'der',
    type: 'spki',
  });
}

/**
 * Verify a signature using the sender's public key
 */
export function verifySignature(payload: unknown, signature: string, publicKey: string): boolean {
  try {
    const canonicalPayload = canonicalize(payload);
    const verify = crypto.createVerify('SHA256');
    verify.update(canonicalPayload);
    verify.end();
    return verify.verify(normalizePublicKey(publicKey), signature, 'base64');
  } catch (error) {
    console.error('[Signature] Verification failed:', error);
    return false;
  }
}

/**
 * Fetch and cache a node's public key
 */
export async function getNodePublicKey(domain: string): Promise<string | null> {
  try {
    const target = resolveFederationDomain(domain);
    if (!target) {
      console.warn(`[Signature] Refusing public key fetch for non-public node ${domain}`);
      return null;
    }
    const normalizedDomain = target.domain;
    if (await isNodeBlocked(normalizedDomain)) {
      console.warn(`[Signature] Refusing public key fetch for blocked node ${normalizedDomain}`);
      return null;
    }

    // Once directly learned, a node key is an identity pin. Do not silently
    // follow a different key later merely because the same origin serves it.
    const pinnedPublicKey = await getPinnedSwarmNodePublicKey(normalizedDomain);
    if (pinnedPublicKey) return pinnedPublicKey;

    const cached = nodePublicKeyCache.get(normalizedDomain);
    if (cached && cached.expiresAt > Date.now()) {
      nodePublicKeyCache.delete(normalizedDomain);
      nodePublicKeyCache.set(normalizedDomain, cached);
      return cached.publicKey;
    }
    if (cached) nodePublicKeyCache.delete(normalizedDomain);

    const pending = pendingNodePublicKeyRequests.get(normalizedDomain);
    if (pending) return await pending;

    const keyRequest = (async (): Promise<string | null> => {
      let response = await safeFederationRequest(`${target.protocol}://${normalizedDomain}/api/node/key`, {
        headers: { 'Accept': 'application/json' },
        timeoutMs: 5_000,
        maxResponseBytes: NODE_PUBLIC_KEY_MAX_RESPONSE_BYTES,
      });

      if (response.status === 404 || response.status === 405) {
        response = await safeFederationRequest(`${target.protocol}://${normalizedDomain}/api/node`, {
          headers: { 'Accept': 'application/json' },
          timeoutMs: 5_000,
          maxResponseBytes: LEGACY_NODE_INFO_MAX_RESPONSE_BYTES,
        });
      }

      if (response.status < 200 || response.status >= 300) {
        console.error(`[Signature] Failed to fetch node public key from ${normalizedDomain}: ${response.status}`);
        return null;
      }

      const data = response.json() as { publicKey?: unknown };
      const publicKey = typeof data.publicKey === 'string'
        ? normalizeNodePublicKey(data.publicKey)
        : null;
      if (publicKey) cacheNodePublicKey(normalizedDomain, publicKey);
      return publicKey;
    })();
    pendingNodePublicKeyRequests.set(normalizedDomain, keyRequest);
    try {
      return await keyRequest;
    } finally {
      pendingNodePublicKeyRequests.delete(normalizedDomain);
    }
  } catch (error) {
    console.error(`[Signature] Error fetching public key from ${domain}:`, error);
    return null;
  }
}

/**
 * Verify a swarm request signature
 * 
 * @param payload - The request payload (without signature field)
 * @param signature - The signature to verify
 * @param senderDomain - The domain of the sender node
 * @returns true if signature is valid, false otherwise
 */
export async function verifySwarmRequest(
  payload: unknown,
  signature: string,
  senderDomain: string
): Promise<boolean> {
  const target = resolveFederationDomain(senderDomain);
  if (!target) {
    console.warn(`[Signature] Rejected non-public swarm node ${senderDomain}`);
    return false;
  }
  const normalizedDomain = target.domain;
  if (await isNodeBlocked(normalizedDomain)) {
    console.warn(`[Signature] Rejected blocked node ${normalizedDomain}`);
    return false;
  }

  // The claimed domain is unauthenticated at this point. Charging its bucket
  // here would let anyone spoof a victim domain until that real peer is rate
  // limited. Keep only origin-independent capacity guards before verification.
  if (isRateLimited('swarm-signature-preauth-global', 1_200, 60 * 1_000)
    || activeSwarmVerifications >= MAX_CONCURRENT_SWARM_VERIFICATIONS) {
    console.warn(`[Signature] Verification capacity exceeded for ${normalizedDomain}`);
    return false;
  }

  activeSwarmVerifications += 1;
  try {
    // Get the sender node's public key. Concurrent requests for the same node
    // share one bounded fetch through pendingNodePublicKeyRequests.
    const publicKey = await getNodePublicKey(normalizedDomain);
    if (!publicKey) {
      console.error(`[Signature] Could not get public key for ${senderDomain}`);
      return false;
    }

    if (!verifySignature(payload, signature, publicKey)) return false;

    // The signature has now authenticated normalizedDomain, so this bucket
    // cannot be poisoned by a request merely claiming to come from that peer.
    if (isRateLimited(`swarm-signature-node:${normalizedDomain}`, 600, 60 * 1_000)) {
      console.warn(`[Signature] Verification capacity exceeded for ${normalizedDomain}`);
      return false;
    }

    // First-contact material remains ephemeral until it has successfully
    // authenticated a request. Invalid requests must not create durable peers.
    try {
      await pinSwarmNodePublicKey(normalizedDomain, publicKey);
    } catch (error) {
      console.warn(`[Signature] Could not pin verified node identity for ${normalizedDomain}`, error);
      return false;
    }
    return true;
  } finally {
    activeSwarmVerifications -= 1;
  }
}

/**
 * Get the node's private key
 */
export async function getNodePrivateKey(): Promise<string> {
  const { getNodeKeypair } = await import('./node-keys');
  const { privateKey } = await getNodeKeypair();
  return privateKey;
}

/**
 * Create a signed payload for sending to another node
 */
export async function createSignedPayload<T>(payload: T): Promise<{ payload: T; signature: string }> {
  const privateKey = await getNodePrivateKey();
  const signature = signPayload(payload, privateKey);
  return { payload, signature };
}
