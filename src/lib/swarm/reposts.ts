export interface SwarmRepostTarget {
  id: string;
  nodeDomain: string;
  originalPostId: string;
}

export async function getViewerSwarmRepostedPostIds(
  targets: SwarmRepostTarget[],
  viewerId: string
): Promise<Set<string>> {
  const repostedIds = new Set<string>();

  if (!targets.length || !viewerId) {
    return repostedIds;
  }

  const { db, userSwarmReposts } = await import('@/db');
  const { and, eq, inArray } = await import('drizzle-orm');

  const domains = Array.from(new Set(targets.map((target) => target.nodeDomain)));
  const originalPostIds = Array.from(new Set(targets.map((target) => target.originalPostId)));

  const rows = await db.query.userSwarmReposts.findMany({
    where: and(
      eq(userSwarmReposts.userId, viewerId),
      inArray(userSwarmReposts.nodeDomain, domains),
      inArray(userSwarmReposts.originalPostId, originalPostIds),
    ),
  });

  const rowKeys = new Set(rows.map((row) => `${row.nodeDomain}:${row.originalPostId}`));

  for (const target of targets) {
    if (rowKeys.has(`${target.nodeDomain}:${target.originalPostId}`)) {
      repostedIds.add(target.id);
    }
  }

  return repostedIds;
}
