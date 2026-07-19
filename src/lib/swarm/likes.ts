import { db, userSwarmLikes } from '@/db';
import { and, eq, inArray } from 'drizzle-orm';

export interface SwarmLikeTarget {
  id: string;
  nodeDomain: string;
  originalPostId: string;
}

/**
 * Interaction state is authored locally before federation delivery, so the
 * local durable ledger is the authority for this viewer. Feed rendering must
 * never make one origin request per post just to rediscover that state.
 */
export async function getViewerSwarmLikedPostIds(
  targets: SwarmLikeTarget[],
  viewerId: string,
): Promise<Set<string>> {
  const likedIds = new Set<string>();
  if (!targets.length || !viewerId) return likedIds;

  const domains = Array.from(new Set(targets.map((target) => target.nodeDomain)));
  const originalPostIds = Array.from(new Set(targets.map((target) => target.originalPostId)));
  const rows = await db.select({
    nodeDomain: userSwarmLikes.nodeDomain,
    originalPostId: userSwarmLikes.originalPostId,
  }).from(userSwarmLikes).where(and(
    eq(userSwarmLikes.userId, viewerId),
    inArray(userSwarmLikes.nodeDomain, domains),
    inArray(userSwarmLikes.originalPostId, originalPostIds),
  ));
  const keys = new Set(rows.map((row) => `${row.nodeDomain}:${row.originalPostId}`));
  for (const target of targets) {
    if (keys.has(`${target.nodeDomain}:${target.originalPostId}`)) likedIds.add(target.id);
  }
  return likedIds;
}
