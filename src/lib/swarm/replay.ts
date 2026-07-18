import { db, swarmInboundActions } from '@/db';
import { lt } from 'drizzle-orm';
import { normalizeNodeDomain } from './node-domain';

let claimsSinceCleanup = 0;

/** Returns true exactly once for a signed interaction identity. */
export async function claimInboundFederationAction(
  sourceDomain: string,
  action: string,
  interactionId: string,
): Promise<boolean> {
  claimsSinceCleanup += 1;
  if (claimsSinceCleanup >= 100) {
    claimsSinceCleanup = 0;
    await db.delete(swarmInboundActions).where(lt(
      swarmInboundActions.createdAt,
      new Date(Date.now() - 2 * 60 * 60 * 1_000),
    ));
  }

  const inserted = await db.insert(swarmInboundActions).values({
    sourceDomain: normalizeNodeDomain(sourceDomain),
    action,
    interactionId,
  }).onConflictDoNothing().returning({ id: swarmInboundActions.id });
  return inserted.length === 1;
}
