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
        const res = await fetch(
          `${protocol}://${target.nodeDomain}/api/swarm/posts/${target.originalPostId}/likes?checkHandle=${encodeURIComponent(viewerHandle)}&checkDomain=${encodeURIComponent(viewerDomain)}`,
          {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(3000),
          }
        );

        if (!res.ok) {
          return;
        }

        const data = await res.json();
        if (data.isLiked) {
          likedIds.add(target.id);
        }
      } catch {
      }
    })
  );

  return likedIds;
}
