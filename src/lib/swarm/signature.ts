/**
 * Swarm Signature Verification
 * 
 * Cryptographic signatures for all swarm interactions to prevent forgery.
 * Each node signs requests with their private key, and recipients verify
 * using the sender's public key.
 */

import crypto from 'crypto';
import { db, users } from '@/db';
import { eq } from 'drizzle-orm';
import { canonicalize } from '@/lib/crypto/user-signing';
import { isNodeBlocked, normalizeNodeDomain } from './node-blocklist';
import { getPublicSwarmDomain } from './node-domain';
import { safeFederationRequest } from './safe-federation-http';

const NODE_PUBLIC_KEY_CACHE_TTL_MS = 60_000;
const MAX_NODE_PUBLIC_KEY_CACHE_ENTRIES = 1_000;
const NODE_PUBLIC_KEY_MAX_RESPONSE_BYTES = 16 * 1024;
// Older nodes expose their key only through /api/node. That document may
// include embedded branding assets, so keep a bounded compatibility fallback
// while new nodes use the deliberately small key-only endpoint.
const LEGACY_NODE_INFO_MAX_RESPONSE_BYTES = 256 * 1024;
const nodePublicKeyCache = new Map<string, { publicKey: string; expiresAt: number }>();
const pendingNodePublicKeyRequests = new Map<string, Promise<string | null>>();

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
      const publicKey = typeof data.publicKey === 'string' ? data.publicKey : null;
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

  // Get the sender node's public key
  const publicKey = await getNodePublicKey(normalizedDomain);
  
  if (!publicKey) {
    console.error(`[Signature] Could not get public key for ${senderDomain}`);
    return false;
  }

  // Verify the signature
  return verifySignature(payload, signature, publicKey);
}

/**
 * Verify a user interaction signature
 * 
 * For user-specific interactions (like, follow, etc), we verify using
 * the user's public key, not the node's.
 * 
 * @param payload - The request payload (without signature field)
 * @param signature - The signature to verify
 * @param userHandle - The full handle of the user (handle@domain)
 * @returns true if signature is valid, false otherwise
 */
export async function verifyUserInteraction(
  payload: unknown,
  signature: string,
  userHandle: string,
  userDomain: string
): Promise<boolean> {
  try {
    const target = resolveFederationDomain(userDomain);
    if (!target) {
      console.warn(`[Signature] Rejected user interaction from non-public node ${userDomain}`);
      return false;
    }
    const normalizedDomain = target.domain;
    if (await isNodeBlocked(normalizedDomain)) {
      console.warn(`[Signature] Rejected user interaction from blocked node ${normalizedDomain}`);
      return false;
    }

    // Try to get cached user
    const fullHandle = `${userHandle}@${normalizedDomain}`;
    const user = await db?.query.users.findFirst({
      where: { handle: fullHandle },
    });

    let publicKey: string | null = null;

    if (user?.publicKey) {
      publicKey = user.publicKey;
    } else {
      // Fetch from remote node
      const response = await safeFederationRequest(`${target.protocol}://${normalizedDomain}/api/users/${encodeURIComponent(userHandle)}`, {
        headers: { 'Accept': 'application/json' },
        timeoutMs: 5_000,
        maxResponseBytes: 64 * 1024,
      });
      
      if (response.status < 200 || response.status >= 300) {
        console.error(`[Signature] Failed to fetch user ${userHandle}@${normalizedDomain}: ${response.status}`);
        return false;
      }

      const userData = response.json() as {
        publicKey?: unknown;
        user?: {
          avatarUrl?: string | null;
          did?: string;
          displayName?: string | null;
          publicKey?: unknown;
        };
      };
      const resolvedPublicKey = userData.user?.publicKey || userData.publicKey;
      publicKey = typeof resolvedPublicKey === 'string' ? resolvedPublicKey : null;

      // Cache the user if we don't have them
      if (!user && publicKey && db) {
        await db.insert(users).values({
          did: userData.user?.did || `did:swarm:${normalizedDomain}:${userHandle}`,
          handle: fullHandle,
          displayName: userData.user?.displayName || userHandle,
          avatarUrl: userData.user?.avatarUrl,
          publicKey,
        }).onConflictDoNothing();
      } else if (user && publicKey && db) {
        // Update cached user's public key
        await db.update(users)
          .set({ publicKey })
          .where(eq(users.id, user.id));
      }
    }

    if (!publicKey) {
      console.error(`[Signature] No public key found for ${fullHandle}`);
      return false;
    }

    // Verify the signature
    return verifySignature(payload, signature, publicKey);
  } catch (error) {
    console.error(`[Signature] Error verifying user interaction:`, error);
    return false;
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
