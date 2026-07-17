import { signedFederationRead } from './signed-read';

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

  await Promise.all(
    targets.map(async (target) => {
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

        const data = res.json() as { isLiked?: boolean };
        if (data.isLiked) {
          likedIds.add(target.id);
        }
      } catch {
      }
    })
  );

  return likedIds;
}
