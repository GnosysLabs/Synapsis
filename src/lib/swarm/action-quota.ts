import { lt, sql } from 'drizzle-orm';

import { db } from '@/db';
import { swarmFederationActionQuotaBuckets } from '@/db/schema';
import { withSqliteLockRetry } from '@/lib/db/sqlite-lock-retry';
import { nodeDomainSchema } from '@/lib/utils/federation';
import { normalizeNodeDomain } from './node-domain';

export const FEDERATED_NODE_ACTION_QUOTA_WINDOW_MS = 60_000;
export const DEFAULT_FEDERATED_NODE_ACTIONS_PER_WINDOW = 600;
export const FEDERATED_ACTION_QUOTA_CLEANUP_BATCH_SIZE = 32;

const MAX_ACTIONS_PER_WINDOW = 1_000_000;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_CLEANUP_BATCH_SIZE = 256;

export interface FederationNodeActionQuotaResult {
  allowed: boolean;
  count: number;
  remaining: number;
  resetAt: number;
}

type FederationActionQuotaDatabase = Pick<typeof db, 'insert' | 'run'>;

interface ConsumeFederationNodeActionQuotaInput {
  sourceDomain: string;
  limit?: number;
  now?: number;
  windowMs?: number;
  cleanupBatchSize?: number;
  database?: FederationActionQuotaDatabase;
}

function boundedPositiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

/**
 * Atomically consume one action from a source node's durable fixed-window
 * quota. The conditional upsert is the concurrency boundary shared by every
 * server process; an in-memory limiter remains useful only as a fast path.
 */
export async function consumeFederationNodeActionQuota(
  input: ConsumeFederationNodeActionQuotaInput,
): Promise<FederationNodeActionQuotaResult> {
  const sourceDomain = normalizeNodeDomain(input.sourceDomain);
  if (!nodeDomainSchema.safeParse(sourceDomain).success) {
    throw new Error('Federation action quota source domain is invalid');
  }

  const limit = boundedPositiveInteger(
    input.limit ?? DEFAULT_FEDERATED_NODE_ACTIONS_PER_WINDOW,
    MAX_ACTIONS_PER_WINDOW,
    'Federation action quota limit',
  );
  const windowMs = boundedPositiveInteger(
    input.windowMs ?? FEDERATED_NODE_ACTION_QUOTA_WINDOW_MS,
    MAX_WINDOW_MS,
    'Federation action quota window',
  );
  const cleanupBatchSize = boundedPositiveInteger(
    input.cleanupBatchSize ?? FEDERATED_ACTION_QUOTA_CLEANUP_BATCH_SIZE,
    MAX_CLEANUP_BATCH_SIZE,
    'Federation action quota cleanup batch',
  );
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('Federation action quota timestamp is invalid');
  }

  const currentBucketStart = Math.floor(now / windowMs) * windowMs;
  const resetAt = currentBucketStart + windowMs;
  const database = input.database ?? db;

  // This single conditional upsert is the atomic consume boundary. Keeping it
  // out of a longer explicit transaction minimizes SQLite writer contention
  // between independent server processes.
  const consumed = await withSqliteLockRetry(() => (
    database.insert(swarmFederationActionQuotaBuckets).values({
      sourceDomain,
      bucketStartMs: currentBucketStart,
      actionCount: 1,
      updatedAt: new Date(now),
    }).onConflictDoUpdate({
      target: [
        swarmFederationActionQuotaBuckets.sourceDomain,
        swarmFederationActionQuotaBuckets.bucketStartMs,
      ],
      set: {
        actionCount: sql`${swarmFederationActionQuotaBuckets.actionCount} + 1`,
        updatedAt: new Date(now),
      },
      setWhere: lt(swarmFederationActionQuotaBuckets.actionCount, limit),
    }).returning({ actionCount: swarmFederationActionQuotaBuckets.actionCount })
  ));

  // Cleanup work is deliberately capped. Each authenticated attempt can
  // remove a small number of expired buckets without causing an unbounded
  // delete or requiring a separate maintenance process.
  const count = consumed[0]?.actionCount;
  if (count === 1) {
    try {
      await withSqliteLockRetry(() => database.run(sql`
        DELETE FROM ${swarmFederationActionQuotaBuckets}
        WHERE rowid IN (
          SELECT rowid
          FROM ${swarmFederationActionQuotaBuckets}
          WHERE ${swarmFederationActionQuotaBuckets.bucketStartMs} < ${currentBucketStart}
          ORDER BY ${swarmFederationActionQuotaBuckets.bucketStartMs} ASC
          LIMIT ${cleanupBatchSize}
        )
      `));
    } catch (error) {
      // Cleanup is maintenance only; the durable quota consume already
      // succeeded and must not be rolled back or reported as unconsumed.
      console.warn('[Swarm] Federation action quota cleanup failed:', error);
    }
  }

  if (count === undefined) {
    return { allowed: false, count: limit, remaining: 0, resetAt };
  }
  return {
    allowed: true,
    count,
    remaining: Math.max(0, limit - count),
    resetAt,
  };
}
