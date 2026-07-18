import { db, swarmInboundActions } from '@/db';
import { sql } from 'drizzle-orm';
import { normalizeNodeDomain } from './node-domain';

// Mentions may be retried for seven days. Tombstones must outlive every
// accepted user action or a fresh node envelope could resurrect an old action.
export const INBOUND_FEDERATION_REPLAY_RETENTION_MS = 8 * 24 * 60 * 60 * 1_000;
const REPLAY_CLEANUP_BATCH_SIZE = 500;

let claimsSinceCleanup = 0;
let cleanupPromise: Promise<void> | null = null;

/** Opportunistic bounded maintenance for routes that claim inside transactions. */
export function scheduleInboundFederationReplayCleanup(): void {
  claimsSinceCleanup += 1;
  if (claimsSinceCleanup < 100 || cleanupPromise) return;
  claimsSinceCleanup = 0;
  const expiresBefore = new Date(Date.now() - INBOUND_FEDERATION_REPLAY_RETENTION_MS);
  cleanupPromise = db.run(sql`
    DELETE FROM ${swarmInboundActions}
    WHERE rowid IN (
      SELECT rowid
      FROM ${swarmInboundActions}
      WHERE ${swarmInboundActions.createdAt} < ${expiresBefore}
      ORDER BY ${swarmInboundActions.createdAt} ASC
      LIMIT ${REPLAY_CLEANUP_BATCH_SIZE}
    )
  `).then(() => undefined).catch((error) => {
    console.error('[Swarm] Replay-ledger cleanup failed:', error);
  }).finally(() => {
    cleanupPromise = null;
  });
}

/** Returns true exactly once for a signed interaction identity. */
export async function claimInboundFederationAction(
  sourceDomain: string,
  action: string,
  interactionId: string,
): Promise<boolean> {
  scheduleInboundFederationReplayCleanup();

  const inserted = await db.insert(swarmInboundActions).values({
    sourceDomain: normalizeNodeDomain(sourceDomain),
    action,
    interactionId,
  }).onConflictDoNothing().returning({ id: swarmInboundActions.id });
  return inserted.length === 1;
}
