import { createHmac } from 'node:crypto';

import { and, eq, lt, sql } from 'drizzle-orm';

import { db } from '@/db';
import { authAbuseQuotaBuckets } from '@/db/schema';
import { withSqliteLockRetry } from '@/lib/db/sqlite-lock-retry';

const MINUTE_MS = 60_000;
const LOGIN_WINDOW_MS = 15 * MINUTE_MS;
const REGISTRATION_WINDOW_MS = 60 * MINUTE_MS;
const GLOBAL_WORK_WINDOW_MS = MINUTE_MS;
const CLEANUP_BATCH_SIZE = 32;

const LOGIN_REQUESTS_PER_CLIENT = 40;
const LOGIN_FAILURES_PER_ACCOUNT = 12;
const LOGIN_CHALLENGE_FAILURES = 3;
const GLOBAL_LOGIN_WORK_PER_MINUTE = 300;

const REGISTRATIONS_PER_CLIENT = 6;
const REGISTRATIONS_PER_IDENTITY = 3;
const REGISTRATION_CHALLENGE_ATTEMPTS = 2;
const GLOBAL_REGISTRATIONS_PER_HOUR = 300;

type AuthAbuseDatabase = Pick<typeof db, 'delete' | 'insert' | 'run' | 'select'>;

export interface AuthAbuseContext {
  clientKey: string;
  identityKey: string;
  clientAddress?: string;
}

export interface AuthAdmission {
  allowed: boolean;
  challengeRequired: boolean;
  retryAfterSeconds: number;
}

export type AuthWorkKind = 'login' | 'register';

interface CounterResult {
  allowed: boolean;
  count: number;
  resetAt: number;
}

interface WorkState {
  login: number;
  register: number;
}

const globalForAuthWork = globalThis as typeof globalThis & {
  synapsisAuthWorkState?: WorkState;
};
const authWorkState = globalForAuthWork.synapsisAuthWorkState ?? { login: 0, register: 0 };
globalForAuthWork.synapsisAuthWorkState = authWorkState;

function hmacKey(scope: string, value: string): string {
  const secret = process.env.AUTH_SECRET || process.env.SESSION_SECRET || 'synapsis-auth-abuse-v1';
  return `${scope}:${createHmac('sha256', secret).update(value).digest('hex')}`;
}

function firstHeaderValue(value: string | null): string | undefined {
  const candidate = value?.split(',')[0]?.trim();
  if (!candidate || candidate.length > 128) return undefined;
  return candidate;
}

/**
 * The production reverse proxy must overwrite these headers. Cloudflare's
 * address wins when present; direct/self-hosted nodes fall back to the first
 * forwarded address and then x-real-ip.
 */
export function getAuthClientAddress(request: Request): string | undefined {
  return firstHeaderValue(request.headers.get('cf-connecting-ip'))
    ?? firstHeaderValue(request.headers.get('x-forwarded-for'))
    ?? firstHeaderValue(request.headers.get('x-real-ip'));
}

export function createAuthAbuseContext(request: Request, identity: string): AuthAbuseContext {
  const clientAddress = getAuthClientAddress(request);
  return {
    clientAddress,
    clientKey: hmacKey('client', clientAddress ?? 'unknown'),
    identityKey: hmacKey('identity', identity.trim().toLowerCase()),
  };
}

function bucketStart(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

async function readCounter(
  bucketKey: string,
  windowMs: number,
  now = Date.now(),
  database: AuthAbuseDatabase = db,
): Promise<number> {
  const start = bucketStart(now, windowMs);
  const [row] = await database.select({ count: authAbuseQuotaBuckets.eventCount })
    .from(authAbuseQuotaBuckets)
    .where(and(
      eq(authAbuseQuotaBuckets.bucketKey, bucketKey),
      eq(authAbuseQuotaBuckets.bucketStartMs, start),
    ))
    .limit(1);
  return row?.count ?? 0;
}

async function consumeCounter(
  bucketKey: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
  database: AuthAbuseDatabase = db,
): Promise<CounterResult> {
  const start = bucketStart(now, windowMs);
  const resetAt = start + windowMs;
  const consumed = await withSqliteLockRetry(() => database
    .insert(authAbuseQuotaBuckets)
    .values({
      bucketKey,
      bucketStartMs: start,
      eventCount: 1,
      updatedAt: new Date(now),
    })
    .onConflictDoUpdate({
      target: [authAbuseQuotaBuckets.bucketKey, authAbuseQuotaBuckets.bucketStartMs],
      set: {
        eventCount: sql`${authAbuseQuotaBuckets.eventCount} + 1`,
        updatedAt: new Date(now),
      },
      setWhere: lt(authAbuseQuotaBuckets.eventCount, limit),
    })
    .returning({ count: authAbuseQuotaBuckets.eventCount }));

  const count = consumed[0]?.count;
  if (count === 1) {
    try {
      const oldestUsefulBucket = now - (24 * 60 * MINUTE_MS);
      await withSqliteLockRetry(() => database.run(sql`
        DELETE FROM ${authAbuseQuotaBuckets}
        WHERE rowid IN (
          SELECT rowid FROM ${authAbuseQuotaBuckets}
          WHERE ${authAbuseQuotaBuckets.bucketStartMs} < ${oldestUsefulBucket}
          ORDER BY ${authAbuseQuotaBuckets.bucketStartMs} ASC
          LIMIT ${CLEANUP_BATCH_SIZE}
        )
      `));
    } catch (error) {
      console.warn('[Auth] Abuse-counter cleanup failed:', error);
    }
  }

  return count === undefined
    ? { allowed: false, count: limit, resetAt }
    : { allowed: true, count, resetAt };
}

function admission(results: CounterResult[], challengeRequired = false): AuthAdmission {
  const blocked = results.filter((result) => !result.allowed);
  const retryAt = Math.max(0, ...blocked.map((result) => result.resetAt));
  return {
    allowed: blocked.length === 0,
    challengeRequired,
    retryAfterSeconds: retryAt === 0 ? 0 : Math.max(1, Math.ceil((retryAt - Date.now()) / 1_000)),
  };
}

export async function admitLoginRequest(context: AuthAbuseContext): Promise<AuthAdmission> {
  const now = Date.now();
  const clientRequest = await consumeCounter(
    `login-request:${context.clientKey}`,
    LOGIN_REQUESTS_PER_CLIENT,
    LOGIN_WINDOW_MS,
    now,
  );
  const globalWork = await consumeCounter(
    'login-work:global',
    GLOBAL_LOGIN_WORK_PER_MINUTE,
    GLOBAL_WORK_WINDOW_MS,
    now,
  );
  const [clientFailures, identityFailures] = await Promise.all([
    readCounter(`login-failure:${context.clientKey}`, LOGIN_WINDOW_MS, now),
    readCounter(`login-failure:${context.identityKey}`, LOGIN_WINDOW_MS, now),
  ]);
  const failureResetAt = bucketStart(now, LOGIN_WINDOW_MS) + LOGIN_WINDOW_MS;
  return admission(
    [
      clientRequest,
      globalWork,
      {
        allowed: identityFailures < LOGIN_FAILURES_PER_ACCOUNT,
        count: identityFailures,
        resetAt: failureResetAt,
      },
    ],
    clientFailures >= LOGIN_CHALLENGE_FAILURES || identityFailures >= LOGIN_CHALLENGE_FAILURES,
  );
}

export async function recordLoginFailure(context: AuthAbuseContext): Promise<void> {
  const now = Date.now();
  await consumeCounter(
    `login-failure:${context.clientKey}`,
    LOGIN_REQUESTS_PER_CLIENT,
    LOGIN_WINDOW_MS,
    now,
  );
  await consumeCounter(
    `login-failure:${context.identityKey}`,
    LOGIN_FAILURES_PER_ACCOUNT,
    LOGIN_WINDOW_MS,
    now,
  );
}

export async function clearLoginFailures(context: AuthAbuseContext): Promise<void> {
  try {
    await withSqliteLockRetry(() => db.delete(authAbuseQuotaBuckets).where(sql`
      ${authAbuseQuotaBuckets.bucketKey} IN (
        ${`login-failure:${context.clientKey}`},
        ${`login-failure:${context.identityKey}`}
      )
    `));
  } catch (error) {
    // A successful authentication must not be converted into a failure by
    // best-effort counter cleanup.
    console.warn('[Auth] Failed to clear login-failure counters:', error);
  }
}

export async function admitRegistrationRequest(context: AuthAbuseContext): Promise<AuthAdmission> {
  const now = Date.now();
  const client = await consumeCounter(
    `register:${context.clientKey}`,
    REGISTRATIONS_PER_CLIENT,
    REGISTRATION_WINDOW_MS,
    now,
  );
  const identity = await consumeCounter(
    `register:${context.identityKey}`,
    REGISTRATIONS_PER_IDENTITY,
    REGISTRATION_WINDOW_MS,
    now,
  );
  const global = await consumeCounter(
    'register:global',
    GLOBAL_REGISTRATIONS_PER_HOUR,
    REGISTRATION_WINDOW_MS,
    now,
  );
  return admission(
    [client, identity, global],
    client.count >= REGISTRATION_CHALLENGE_ATTEMPTS
      || identity.count >= REGISTRATION_CHALLENGE_ATTEMPTS,
  );
}

/** A small per-process ceiling complements the durable cross-process quotas. */
export function tryAcquireAuthWork(kind: AuthWorkKind): (() => void) | null {
  const limit = kind === 'login' ? 8 : 2;
  if (authWorkState[kind] >= limit) return null;
  authWorkState[kind] += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    authWorkState[kind] = Math.max(0, authWorkState[kind] - 1);
  };
}
