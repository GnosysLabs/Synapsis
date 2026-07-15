/**
 * Server-side signature verification for user actions
 * 
 * Strict Verification Rules:
 * - ECDSA P-256 (ES256) ONLY.
 * - DB-backed deduplication (signed_action_dedupe).
 * - Strict 5-minute freshness window.
 * - Canonical verification (must match client exactly).
 */

import { db } from '@/db';
import { users, signedActionDedupe } from '@/db/schema';
import { eq, lt } from 'drizzle-orm';
import { canonicalize, importPublicKey, base64UrlToBase64 } from '@/lib/crypto/user-signing';
// Note: user-signing helpers are isomorphic (work in Node via webcrypto polyfill/availability)
import crypto from 'crypto';
import { isRateLimited } from '@/lib/rate-limit';

// Use Node's webcrypto for server-side if not global
const cryptoSubtle = globalThis.crypto?.subtle || crypto.webcrypto.subtle;
const DEDUPE_RETENTION_MS = 10 * 60 * 1000;
const DEDUPE_CLEANUP_INTERVAL_MS = 60 * 1000;
let nextDedupeCleanupAt = 0;

async function pruneExpiredSignedActions(now: number): Promise<void> {
  if (now < nextDedupeCleanupAt) return;
  nextDedupeCleanupAt = now + DEDUPE_CLEANUP_INTERVAL_MS;

  try {
    await db.delete(signedActionDedupe).where(
      lt(signedActionDedupe.createdAt, new Date(now - DEDUPE_RETENTION_MS)),
    );
  } catch (error) {
    // Replay verification must not become unavailable because maintenance
    // failed; the next process or interval will retry the bounded cleanup.
    console.error('[Verify] Signed-action cleanup failed:', error);
  }
}

export interface SignedAction<TData = Record<string, string>> {
  action: string;
  data: TData;
  did: string;
  handle: string;
  ts: number;
  nonce: string;
  sig: string;
}

export class SignedActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignedActionError';
  }
}

/**
 * Verify a signed action against a specific public key
 */
export async function verifyActionSignature(signedAction: SignedAction<unknown>, publicKeyStr: string): Promise<boolean> {
  try {
    const { sig, ...payload } = signedAction;
    const canonicalString = canonicalize(payload);
    const encoder = new TextEncoder();
    const dataBytes = encoder.encode(canonicalString);

    // Convert signature from Base64Url to buffer
    const sigBase64 = base64UrlToBase64(sig);
    const sigBuffer = Buffer.from(sigBase64, 'base64');

    // Import public key (stored as SPKI Base64)
    const publicKey = await importPublicKey(publicKeyStr);

    return await cryptoSubtle.verify(
      {
        name: 'ECDSA',
        hash: { name: 'SHA-256' },
      },
      publicKey,
      sigBuffer,
      dataBytes
    );
  } catch (error) {
    console.error('[Verify] Crypto exception:', error);
    return false;
  }
}

/**
 * Verify a signed user action (looks up user in DB)
 * 
 * @param signedAction - The signed action payload
 * @returns The user if signature is valid and not replayed
 */
export async function verifyUserAction(signedAction: SignedAction<unknown>): Promise<{
  valid: boolean;
  user?: typeof users.$inferSelect;
  error?: string;
}> {
  if (!db) {
    return { valid: false, error: 'Database not available' };
  }

  const payload = {
    action: signedAction.action,
    data: signedAction.data,
    did: signedAction.did,
    handle: signedAction.handle,
    nonce: signedAction.nonce,
    ts: signedAction.ts,
  };

  // 1. FRESHNESS CHECK (Fail fast before DB/Crypto)
  const now = Date.now();
  const diff = Math.abs(now - payload.ts);
  // Allow 5 minutes clock skew
  const fiveMinutesMs = 5 * 60 * 1000;

  if (diff > fiveMinutesMs) {
    return { valid: false, error: 'INVALID_TIMESTAMP: Request too old or in future' };
  }

  // 2. FETCH USER & KEY
  const user = await db.query.users.findFirst({
    where: { did: payload.did },
  });

  if (!user) {
    return { valid: false, error: 'User not found' };
  }

  if (user.handle !== payload.handle) {
    return { valid: false, error: 'Handle mismatch' };
  }

  // 3. CRYPTOGRAPHIC VERIFICATION
  const isValid = await verifyActionSignature(signedAction, user.publicKey);

  if (!isValid) {
    return { valid: false, error: 'INVALID_SIGNATURE' };
  }

  await pruneExpiredSignedActions(now);

  // 4. ACTION ID HASH COMPUTATION
  const canonicalString = canonicalize(payload);
  const actionIdHash = crypto.createHash('sha256').update(canonicalString).digest('hex');

  // 5. EXISTING REPLAY CHECK. Avoid charging the authenticated account bucket
  // for an action already recorded in durable replay storage. The unique
  // insert below remains the authoritative guard for concurrent requests.
  const existingReplay = await db
    .select({ actionId: signedActionDedupe.actionId })
    .from(signedActionDedupe)
    .where(eq(signedActionDedupe.actionId, actionIdHash))
    .limit(1);

  if (existingReplay.length > 0) {
    return { valid: false, error: 'REPLAYED_NONCE' };
  }

  // 6. AUTHENTICATED RATE LIMIT. Charge quota before creating durable replay
  // state so a fresh, unique action rejected for excess volume leaves no row.
  // Invalid signatures and attacker-controlled public DIDs never create
  // per-account limiter entries or consume quota.
  const requestsPerMinute = payload.action === 'chat_e2ee' ? 120 : 5;
  if (isRateLimited(`${user.id}:${payload.action}`, requestsPerMinute, 60 * 1000)) {
    return { valid: false, error: 'RATE_LIMITED' };
  }

  // 7. AUTHORITATIVE REPLAY INSERT. Another request can race the read above,
  // so rely on the primary-key constraint to reject concurrent duplicates.
  try {
    await db.insert(signedActionDedupe).values({
      actionId: actionIdHash,
      did: payload.did,
      nonce: payload.nonce,
      ts: payload.ts,
    });
  } catch (err: unknown) {
    // Check for unique constraint violation (duplicate key)
    const errorCode = typeof err === 'object' && err !== null && 'code' in err
      ? (err as { code?: unknown }).code
      : undefined;
    const errorMessage = err instanceof Error ? err.message : '';
    if (errorCode === '23505' || /unique|constraint/i.test(errorMessage)) {
      return { valid: false, error: 'REPLAYED_NONCE' };
    }
    console.error('[Verify] Dedupe error:', err);
    throw err; // Internal error
  }

  return { valid: true, user };
}

/**
 * Middleware to require a signed action
 * Throws an error if signature is invalid
 */
export async function requireSignedAction(signedAction: SignedAction<unknown>): Promise<typeof users.$inferSelect> {
  const result = await verifyUserAction(signedAction);

  if (!result.valid) {
    throw new SignedActionError(result.error || 'Invalid signature');
  }

  return result.user!;
}
