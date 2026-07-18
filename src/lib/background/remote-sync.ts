/** Durable, fair refresh scheduling for accounts followed by local users. */
import crypto from 'node:crypto';
import { db, remoteFollowSyncStates } from '@/db';
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { mapWithConcurrency } from '@/lib/async/concurrency';
import { cacheSwarmUserPosts, isSwarmNode } from '@/lib/swarm/interactions';

const MIN_SYNC_INTERVAL_MS = 5 * 60_000;
const RETRY_BACKOFF_BASE_MS = 60_000;
const RETRY_BACKOFF_MAX_MS = 60 * 60_000;
const MAX_SYNC_TARGETS_PER_RUN = 20;
const MAX_CONCURRENT_PROFILE_SYNCS = 4;
const SYNC_LEASE_MS = 45_000;

interface SyncResult {
  synced: number;
  skipped: number;
  errors: number;
  details: Array<{ handle: string; cached: number; error?: string }>;
}

interface ClaimedTarget {
  targetHandle: string;
  nodeDomain: string;
  leaseOwner: string;
}

let activeSync: Promise<SyncResult> | null = null;

function retryDelay(failures: number): number {
  return Math.min(
    RETRY_BACKOFF_BASE_MS * (2 ** Math.min(Math.max(failures - 1, 0), 8)),
    RETRY_BACKOFF_MAX_MS,
  );
}

function successJitter(targetHandle: string): number {
  return crypto.createHash('sha256').update(targetHandle).digest().readUInt32BE(0) % 120_000;
}

async function seedFollowSyncStates(): Promise<void> {
  await db.run(sql`
    insert into ${remoteFollowSyncStates} (
      ${remoteFollowSyncStates.targetHandle},
      ${remoteFollowSyncStates.nodeDomain}
    )
    select
      lower(target_handle),
      lower(substr(target_handle, instr(target_handle, '@') + 1))
    from remote_follows
    where instr(target_handle, '@') > 1
      and instr(target_handle, '@') < length(target_handle)
    group by lower(target_handle)
    on conflict (${remoteFollowSyncStates.targetHandle}) do update set
      ${remoteFollowSyncStates.nodeDomain} = excluded.node_domain
  `);
  await db.run(sql`
    delete from ${remoteFollowSyncStates}
    where not exists (
      select 1 from remote_follows
      where lower(remote_follows.target_handle) = ${remoteFollowSyncStates.targetHandle}
    )
  `);
}

async function claimTargets(): Promise<ClaimedTarget[]> {
  await seedFollowSyncStates();
  const now = new Date();
  const candidates = await db.select({
    targetHandle: remoteFollowSyncStates.targetHandle,
    nodeDomain: remoteFollowSyncStates.nodeDomain,
  }).from(remoteFollowSyncStates).where(and(
    lte(remoteFollowSyncStates.nextAttemptAt, now),
    or(
      isNull(remoteFollowSyncStates.leaseExpiresAt),
      lte(remoteFollowSyncStates.leaseExpiresAt, now),
    ),
  )).orderBy(
    asc(remoteFollowSyncStates.lastSuccessAt),
    asc(remoteFollowSyncStates.nextAttemptAt),
    asc(remoteFollowSyncStates.targetHandle),
  ).limit(MAX_SYNC_TARGETS_PER_RUN * 3);

  const claimed: ClaimedTarget[] = [];
  for (const candidate of candidates) {
    if (claimed.length >= MAX_SYNC_TARGETS_PER_RUN) break;
    const leaseOwner = crypto.randomUUID();
    const [updated] = await db.update(remoteFollowSyncStates).set({
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() + SYNC_LEASE_MS),
      lastAttemptAt: now,
      updatedAt: now,
    }).where(and(
      eq(remoteFollowSyncStates.targetHandle, candidate.targetHandle),
      lte(remoteFollowSyncStates.nextAttemptAt, now),
      or(
        isNull(remoteFollowSyncStates.leaseExpiresAt),
        lte(remoteFollowSyncStates.leaseExpiresAt, now),
      ),
    )).returning({ targetHandle: remoteFollowSyncStates.targetHandle });
    if (updated) claimed.push({ ...candidate, leaseOwner });
  }
  return claimed;
}

async function finishTarget(
  target: ClaimedTarget,
  outcome: { success: true } | { success: false; error: string },
): Promise<void> {
  const state = await db.query.remoteFollowSyncStates.findFirst({
    where: { AND: [
      { targetHandle: target.targetHandle },
      { leaseOwner: target.leaseOwner },
    ] },
  });
  if (!state) return;
  const failures = outcome.success ? 0 : state.failures + 1;
  const now = new Date();
  await db.update(remoteFollowSyncStates).set({
    failures,
    nextAttemptAt: new Date(Date.now() + (outcome.success
      ? MIN_SYNC_INTERVAL_MS + successJitter(target.targetHandle)
      : retryDelay(failures))),
    lastSuccessAt: outcome.success ? now : state.lastSuccessAt,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: outcome.success ? null : outcome.error.slice(0, 1_000),
    updatedAt: now,
  }).where(and(
    eq(remoteFollowSyncStates.targetHandle, target.targetHandle),
    eq(remoteFollowSyncStates.leaseOwner, target.leaseOwner),
  ));
}

async function syncTarget(target: ClaimedTarget): Promise<{ handle: string; cached: number; error?: string }> {
  try {
    const atIndex = target.targetHandle.lastIndexOf('@');
    const handle = target.targetHandle.slice(0, atIndex);
    if (atIndex <= 0 || !await isSwarmNode(target.nodeDomain)) {
      throw new Error('Target node is not an active trusted swarm peer');
    }
    const result = await cacheSwarmUserPosts(
      handle,
      target.nodeDomain,
      target.targetHandle,
      20,
    );
    if (!result.success) throw new Error('Remote profile refresh failed');
    await finishTarget(target, { success: true });
    return { handle: target.targetHandle, cached: result.cached };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await finishTarget(target, { success: false, error: message });
    return { handle: target.targetHandle, cached: 0, error: message };
  }
}

async function runRemoteFollowsSync(origin: string): Promise<SyncResult> {
  void origin;
  const targets = await claimTargets();
  const details = await mapWithConcurrency(targets, MAX_CONCURRENT_PROFILE_SYNCS, syncTarget);
  return {
    synced: details.filter((detail) => !detail.error).length,
    skipped: Math.max(0, MAX_SYNC_TARGETS_PER_RUN - targets.length),
    errors: details.filter((detail) => Boolean(detail.error)).length,
    details,
  };
}

/** Sync a bounded batch. Concurrent invocations in one process share a run. */
export function syncRemoteFollowsPosts(origin: string): Promise<SyncResult> {
  if (activeSync) return activeSync;
  const operation = runRemoteFollowsSync(origin);
  activeSync = operation;
  void operation.finally(() => {
    if (activeSync === operation) activeSync = null;
  });
  return operation;
}

/** Test hook; durable scheduling state intentionally remains in the database. */
export function clearSyncCache(): void {
  activeSync = null;
}
