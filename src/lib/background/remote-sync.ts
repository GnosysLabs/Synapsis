/**
 * Remote Follows Sync
 *
 * Periodically syncs posts from remote users that local users follow.
 * Swarm-only implementation.
 */

import { db } from '@/db';
import { cacheSwarmUserPosts, isSwarmNode } from '@/lib/swarm/interactions';

const MIN_SYNC_INTERVAL_MS = 60 * 1_000;
const RETRY_BACKOFF_BASE_MS = 5 * 60 * 1_000;
const RETRY_BACKOFF_MAX_MS = 60 * 60 * 1_000;
const MAX_SYNC_TARGETS_PER_RUN = 20;
const REMOTE_FOLLOW_SCAN_LIMIT = MAX_SYNC_TARGETS_PER_RUN * 4;
const MAX_SYNC_RUN_MS = 45 * 1_000;

interface TargetSyncState {
  failures: number;
  nextAttemptAt: number;
}

interface SyncResult {
  synced: number;
  skipped: number;
  errors: number;
  details: Array<{ handle: string; cached: number; error?: string }>;
}

const targetSyncStates = new Map<string, TargetSyncState>();
let remoteFollowOffset = 0;
let activeSync: Promise<SyncResult> | null = null;

function retryDelay(failures: number): number {
  return Math.min(
    RETRY_BACKOFF_BASE_MS * (2 ** Math.min(Math.max(failures - 1, 0), 8)),
    RETRY_BACKOFF_MAX_MS,
  );
}

function reserveTarget(targetHandle: string, now: number): void {
  const existing = targetSyncStates.get(targetHandle);
  targetSyncStates.set(targetHandle, {
    failures: existing?.failures ?? 0,
    // Reserve before any remote I/O so a second caller cannot duplicate the request.
    nextAttemptAt: now + MIN_SYNC_INTERVAL_MS,
  });
}

function scheduleRetry(targetHandle: string, now: number): void {
  const failures = (targetSyncStates.get(targetHandle)?.failures ?? 0) + 1;
  targetSyncStates.set(targetHandle, {
    failures,
    nextAttemptAt: now + retryDelay(failures),
  });
}

function scheduleNextSync(targetHandle: string, now: number): void {
  targetSyncStates.set(targetHandle, {
    failures: 0,
    nextAttemptAt: now + MIN_SYNC_INTERVAL_MS,
  });
}

async function loadRemoteFollowBatch(): Promise<string[]> {
  const queryBatch = async (offset: number) => db.query.remoteFollows.findMany({
    columns: { targetHandle: true },
    orderBy: (remoteFollows, { asc }) => [
      asc(remoteFollows.targetHandle),
      asc(remoteFollows.id),
    ],
    limit: REMOTE_FOLLOW_SCAN_LIMIT,
    offset,
  });

  let rows = await queryBatch(remoteFollowOffset);
  if (rows.length === 0 && remoteFollowOffset > 0) {
    remoteFollowOffset = 0;
    rows = await queryBatch(0);
  }

  const targetHandles = new Set<string>();
  let consumedRows = 0;
  for (const follow of rows) {
    consumedRows += 1;
    targetHandles.add(follow.targetHandle);
    if (targetHandles.size >= MAX_SYNC_TARGETS_PER_RUN) break;
  }

  // Advance only past rows represented by this batch. Advancing past the
  // entire scan would permanently skip unsliced handles when fewer than the
  // scan limit exist, and would defer extra unique handles until a full wrap.
  remoteFollowOffset += consumedRows;

  return [...targetHandles];
}

async function runRemoteFollowsSync(origin: string): Promise<SyncResult> {
  void origin;
  const result: SyncResult = { synced: 0, skipped: 0, errors: 0, details: [] };
  const deadlineAt = Date.now() + MAX_SYNC_RUN_MS;

  try {
    const targetHandles = await loadRemoteFollowBatch();

    for (const [index, targetHandle] of targetHandles.entries()) {
      const now = Date.now();
      if (now >= deadlineAt) {
        result.skipped += targetHandles.length - index;
        break;
      }

      const syncState = targetSyncStates.get(targetHandle);
      if (syncState && now < syncState.nextAttemptAt) {
        result.skipped++;
        continue;
      }

      const atIndex = targetHandle.lastIndexOf('@');
      if (atIndex <= 0 || atIndex === targetHandle.length - 1) {
        result.skipped++;
        scheduleRetry(targetHandle, now);
        continue;
      }

      const handle = targetHandle.slice(0, atIndex);
      const domain = targetHandle.slice(atIndex + 1);
      reserveTarget(targetHandle, now);

      try {
        if (!await isSwarmNode(domain)) {
          result.skipped++;
          scheduleRetry(targetHandle, Date.now());
          continue;
        }

        const swarmResult = await cacheSwarmUserPosts(handle, domain, targetHandle, 20);
        const cached = swarmResult.cached;

        if (cached > 0 || swarmResult.skipped > 0) {
          scheduleNextSync(targetHandle, Date.now());
        } else {
          // The cache API intentionally coalesces fetch failures and empty responses.
          // Backing both off keeps an unavailable node from consuming every round.
          scheduleRetry(targetHandle, Date.now());
        }

        if (cached > 0) {
          result.synced++;
          result.details.push({ handle: targetHandle, cached });
        } else {
          result.skipped++;
        }
      } catch (error) {
        scheduleRetry(targetHandle, Date.now());
        result.errors++;
        result.details.push({
          handle: targetHandle,
          cached: 0,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  } catch (error) {
    console.error('[RemoteSync] Error syncing remote follows:', error);
    result.errors++;
  }

  return result;
}

/**
 * Sync a bounded batch of remote follows. Concurrent invocations share one run.
 */
export function syncRemoteFollowsPosts(origin: string): Promise<SyncResult> {
  if (activeSync) return activeSync;

  const operation = runRemoteFollowsSync(origin);
  activeSync = operation;
  void operation.then(
    () => {
      if (activeSync === operation) activeSync = null;
    },
    () => {
      if (activeSync === operation) activeSync = null;
    },
  );
  return operation;
}

/**
 * Clear the sync cache (useful for testing or forcing a full resync).
 */
export function clearSyncCache(): void {
  targetSyncStates.clear();
  remoteFollowOffset = 0;
}
