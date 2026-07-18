import { z } from 'zod';

import { mapWithConcurrency } from '@/lib/async/concurrency';
import { parseSwarmPostId } from './post-id';
import { signedFederationRead } from './signed-read';

const MAX_REPLY_COUNT_TARGETS = 50;
const MAX_CONCURRENT_REPLY_COUNT_REQUESTS = 6;
const remoteRepliesResponseSchema = z.strictObject({
  replies: z.array(z.unknown()).max(50).optional(),
}).passthrough();

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
  await mapWithConcurrency(
    Array.from(targets).slice(0, MAX_REPLY_COUNT_TARGETS),
    MAX_CONCURRENT_REPLY_COUNT_REQUESTS,
    async ([postId, target]) => {
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

        const parsed = remoteRepliesResponseSchema.safeParse(response.json());
        if (parsed.success && parsed.data.replies) {
          counts.set(postId, parsed.data.replies.length);
        }
      } catch {
        // Keep the snapshot count when an origin node is temporarily unavailable.
      }
    },
  );

  return posts.map((post) => {
    const count = counts.get(post.id);
    return count === undefined ? post : { ...post, repliesCount: count };
  });
}
