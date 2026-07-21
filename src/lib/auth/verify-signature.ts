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
import { canonicalize, importPublicKey } from '@/lib/crypto/user-signing';
// Note: user-signing helpers are isomorphic (work in Node via webcrypto polyfill/availability)
import crypto from 'crypto';
import { isRateLimited } from '@/lib/rate-limit';

// Use Node's webcrypto for server-side if not global
const cryptoSubtle = globalThis.crypto?.subtle || crypto.webcrypto.subtle;
const DEDUPE_RETENTION_MS = 10 * 60 * 1000;
const DEDUPE_CLEANUP_INTERVAL_MS = 60 * 1000;
const P256_SIGNATURE_BYTES = 64;
const DEFAULT_ACTION_REQUESTS_PER_MINUTE = 5;
const RELATIONSHIP_ACTION_REQUESTS_PER_MINUTE = 30;
let nextDedupeCleanupAt = 0;

function actionRequestsPerMinute(action: string): number {
  if (action === 'chat_e2ee') return 120;
  if (action === 'follow' || action === 'unfollow') {
    return RELATIONSHIP_ACTION_REQUESTS_PER_MINUTE;
  }
  return DEFAULT_ACTION_REQUESTS_PER_MINUTE;
}

function parseCanonicalP256Signature(sig: string): Buffer | null {
  // Node's base64url decoder accepts padding, ignored characters, and
  // non-zero trailing pad bits. Require the one canonical, unpadded spelling
  // so the same signature bytes cannot have multiple wire representations.
  if (typeof sig !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;

  const decoded = Buffer.from(sig, 'base64url');
  if (decoded.length !== P256_SIGNATURE_BYTES) return null;
  if (decoded.toString('base64url') !== sig) return null;

  // Do not require low-S yet. WebCrypto P-256 signers used by current clients
  // emit both low- and high-S signatures, so that needs a versioned migration.
  return decoded;
}

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
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = 'SignedActionError';
    this.code = code;
  }
}

/**
 * Verify any canonical signed payload against a specific public key.
 */
export async function verifyCanonicalSignature<T extends object & { sig: string }>(
  signedPayload: T,
  publicKeyStr: string,
): Promise<boolean> {
  try {
    const { sig, ...payload } = signedPayload;
    const canonicalString = canonicalize(payload);
    const encoder = new TextEncoder();
    const dataBytes = encoder.encode(canonicalString);

    const sigBuffer = parseCanonicalP256Signature(sig);
    if (!sigBuffer) return false;
    const signatureBytes = Uint8Array.from(sigBuffer);

    // Import public key (stored as SPKI Base64)
    const publicKey = await importPublicKey(publicKeyStr);

    return await cryptoSubtle.verify(
      {
        name: 'ECDSA',
        hash: { name: 'SHA-256' },
      },
      publicKey,
      signatureBytes,
      dataBytes
    );
  } catch (error) {
    console.error('[Verify] Crypto exception:', error);
    return false;
  }
}

/**
 * Verify a signed account action against a specific public key.
 */
export async function verifyActionSignature(
  signedAction: SignedAction<unknown>,
  publicKeyStr: string,
): Promise<boolean> {
  return verifyCanonicalSignature(signedAction, publicKeyStr);
}

/**
 * Apply shared replay protection and rate limiting after a signature and
 * identity have already been authenticated.
 */
export async function recordVerifiedAction(input: {
  canonicalPayload: unknown;
  identity: string;
  rateLimitKey: string;
  nonce: string;
  ts: number;
  maxRequests: number;
}): Promise<string | null> {
  const now = Date.now();
  await pruneExpiredSignedActions(now);

  const canonicalString = canonicalize(input.canonicalPayload);
  const actionIdHash = crypto.createHash('sha256').update(canonicalString).digest('hex');
  const existingReplay = await db
    .select({ actionId: signedActionDedupe.actionId })
    .from(signedActionDedupe)
    .where(eq(signedActionDedupe.actionId, actionIdHash))
    .limit(1);

  if (existingReplay.length > 0) return 'REPLAYED_NONCE';
  if (isRateLimited(input.rateLimitKey, input.maxRequests, 60 * 1000)) return 'RATE_LIMITED';

  try {
    await db.insert(signedActionDedupe).values({
      actionId: actionIdHash,
      did: input.identity,
      nonce: input.nonce,
      ts: input.ts,
    });
  } catch (err: unknown) {
    const errorCode = typeof err === 'object' && err !== null && 'code' in err
      ? (err as { code?: unknown }).code
      : undefined;
    const errorMessage = err instanceof Error ? err.message : '';
    if (errorCode === '23505' || /unique|constraint/i.test(errorMessage)) {
      return 'REPLAYED_NONCE';
    }
    console.error('[Verify] Dedupe error:', err);
    throw err;
  }

  return null;
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

  const requestsPerMinute = actionRequestsPerMinute(payload.action);
  const acceptanceError = await recordVerifiedAction({
    canonicalPayload: payload,
    identity: payload.did,
    rateLimitKey: `${user.id}:${payload.action}`,
    nonce: payload.nonce,
    ts: payload.ts,
    maxRequests: requestsPerMinute,
  });
  if (acceptanceError) return { valid: false, error: acceptanceError };

  return { valid: true, user };
}

/**
 * Middleware to require a signed action
 * Throws an error if signature is invalid
 */
export async function requireSignedAction(
  signedAction: SignedAction<unknown>,
  expectedAction?: string,
): Promise<typeof users.$inferSelect> {
  if (expectedAction && signedAction.action !== expectedAction) {
    throw new SignedActionError('INVALID_ACTION');
  }

  const result = await verifyUserAction(signedAction);

  if (!result.valid) {
    throw new SignedActionError(result.error || 'INVALID_SIGNATURE');
  }

  return result.user!;
}
