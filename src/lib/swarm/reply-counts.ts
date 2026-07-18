import { parseSwarmPostId } from './post-id';
import { signedFederationRead } from './signed-read';

interface FederatedReplyCountPost {
  id: string;
  repliesCount?: number;
}

/**
 * Refresh reply counts for remote stories whose locally stored repost snapshot
 * can become stale after new replies are delivered to the origin node.
 */
export async function refreshFederatedReplyCounts<T extends FederatedReplyCountPost>(
  posts: readonly T[],
): Promise<T[]> {
  const targets = new Map<string, { domain: string; originalPostId: string }>();

  for (const post of posts) {
    const parsed = parseSwarmPostId(post.id);
    if (parsed) targets.set(post.id, parsed);
  }

  const counts = new Map<string, number>();
  await Promise.all(Array.from(targets, async ([postId, target]) => {
    try {
      const protocol = target.domain.includes('localhost') ? 'http' : 'https';
      const response = await signedFederationRead(
        `${protocol}://${target.domain}/api/swarm/replies?postId=${encodeURIComponent(target.originalPostId)}`,
        {
          headers: { Accept: 'application/json' },
          timeoutMs: 4_000,
          maxResponseBytes: 1024 * 1024,
        },
      );
      if (response.status < 200 || response.status >= 300) return;

      const data = response.json() as { replies?: unknown[] };
      if (Array.isArray(data.replies)) counts.set(postId, data.replies.length);
    } catch {
      // Keep the snapshot count when an origin node is temporarily unavailable.
    }
  }));

  return posts.map((post) => {
    const count = counts.get(post.id);
    return count === undefined ? post : { ...post, repliesCount: count };
  });
}
