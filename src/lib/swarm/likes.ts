import { signedFederationRead } from './signed-read';
import { mapWithConcurrency } from '@/lib/async/concurrency';
import { z } from 'zod';

const MAX_LIKE_STATUS_TARGETS = 50;
const MAX_CONCURRENT_LIKE_STATUS_REQUESTS = 6;
const likeStatusResponseSchema = z.strictObject({ isLiked: z.boolean() });

export interface SwarmLikeTarget {
  id: string;
  nodeDomain: string;
  originalPostId: string;
}

export async function getViewerSwarmLikedPostIds(
  targets: SwarmLikeTarget[],
  viewerHandle: string,
  viewerDomain: string
): Promise<Set<string>> {
  const likedIds = new Set<string>();

  if (!targets.length || !viewerHandle || !viewerDomain) {
    return likedIds;
  }

  await mapWithConcurrency(
    targets.slice(0, MAX_LIKE_STATUS_TARGETS),
    MAX_CONCURRENT_LIKE_STATUS_REQUESTS,
    async (target) => {
      try {
        const protocol = target.nodeDomain.includes('localhost') ? 'http' : 'https';
        const res = await signedFederationRead(
          `${protocol}://${target.nodeDomain}/api/swarm/posts/${target.originalPostId}/likes?checkHandle=${encodeURIComponent(viewerHandle)}&checkDomain=${encodeURIComponent(viewerDomain)}`,
          {
            headers: { Accept: 'application/json' },
            timeoutMs: 3_000,
            maxResponseBytes: 32 * 1024,
          }
        );

        if (res.status < 200 || res.status >= 300) {
          return;
        }

        const data = likeStatusResponseSchema.safeParse(res.json());
        if (data.success && data.data.isLiked) {
          likedIds.add(target.id);
        }
      } catch {
      }
    },
  );

  return likedIds;
}
