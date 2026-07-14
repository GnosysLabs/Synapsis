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
import { eq } from 'drizzle-orm';
import { canonicalize, importPublicKey, base64UrlToBase64 } from '@/lib/crypto/user-signing';
// Note: user-signing helpers are isomorphic (work in Node via webcrypto polyfill/availability)
import crypto from 'crypto';
import { isRateLimited } from '@/lib/rate-limit';

// Use Node's webcrypto for server-side if not global
const cryptoSubtle = globalThis.crypto?.subtle || require('crypto').webcrypto.subtle;

export interface SignedAction {
  action: string;
  data: any;
  did: string;
  handle: string;
  ts: number;
  nonce: string;
  sig: string;
}

/**
 * Verify a signed action against a specific public key
 */
export async function verifyActionSignature(signedAction: SignedAction, publicKeyStr: string): Promise<boolean> {
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
export async function verifyUserAction(signedAction: SignedAction): Promise<{
  valid: boolean;
  user?: typeof users.$inferSelect;
  error?: string;
}> {
  if (!db) {
    return { valid: false, error: 'Database not available' };
  }

  const { sig, ...payload } = signedAction;

  // 1. RATE LIMIT CHECK (Fail fast before heavy operations)
  // 5 requests per minute per DID
  if (isRateLimited(payload.did, 5, 60 * 1000)) {
    return { valid: false, error: 'RATE_LIMITED' };
  }

  // 2. FRESHNESS CHECK (Fail fast before DB/Crypto)
  const now = Date.now();
  const diff = Math.abs(now - payload.ts);
  // Allow 5 minutes clock skew
  const fiveMinutesMs = 5 * 60 * 1000;

  if (diff > fiveMinutesMs) {
    return { valid: false, error: 'INVALID_TIMESTAMP: Request too old or in future' };
  }

  // 3. FETCH USER & KEY
  const user = await db.query.users.findFirst({
    where: { did: payload.did },
  });

  if (!user) {
    return { valid: false, error: 'User not found' };
  }

  if (user.handle !== payload.handle) {
    return { valid: false, error: 'Handle mismatch' };
  }

  // 4. CRYPTOGRAPHIC VERIFICATION
  const isValid = await verifyActionSignature(signedAction, user.publicKey);

  if (!isValid) {
    return { valid: false, error: 'INVALID_SIGNATURE' };
  }

  // 5. ACTION ID HASH COMPUTATION
  const canonicalString = canonicalize(payload);
  const actionIdHash = crypto.createHash('sha256').update(canonicalString).digest('hex');

  // 6. REPLAY PROTECTION (DB)
  try {
    await db.insert(signedActionDedupe).values({
      actionId: actionIdHash,
      did: payload.did,
      nonce: payload.nonce,
      ts: payload.ts,
    });
  } catch (err: any) {
    // Check for unique constraint violation (duplicate key)
    if (err.code === '23505') { // Postgres unique_violation code
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
export async function requireSignedAction(signedAction: SignedAction): Promise<typeof users.$inferSelect> {
  const result = await verifyUserAction(signedAction);

  if (!result.valid) {
    throw new Error(result.error || 'Invalid signature');
  }

  return result.user!;
}
