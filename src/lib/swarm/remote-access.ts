import { eq } from 'drizzle-orm';

import {
  db,
  remoteFeedStories,
  remotePosts,
  swarmNodes,
  userSwarmLikes,
  userSwarmReposts,
} from '@/db';
import { normalizeNodeDomain } from './node-domain';
export {
  isRemoteNodeBlockResponse,
  NODE_BLOCKED_CODE,
  ORIGIN_UNAVAILABLE_CONTENT,
} from './remote-access-protocol';

export async function isRemoteNodeAccessDenied(domain: string): Promise<boolean> {
  const normalizedDomain = normalizeNodeDomain(domain);
  const node = await db.query.swarmNodes.findFirst({
    where: { domain: normalizedDomain },
    columns: { remoteAccessDeniedAt: true },
  });
  return Boolean(node?.remoteAccessDeniedAt);
}

/**
 * Quarantine an origin after it explicitly rejects this node. Ordinary cached
 * feed rows and likes are removed. A local user's repost remains as a scrubbed
 * tombstone so their history cannot silently resurrect the remote content.
 */
export async function markRemoteNodeAccessDenied(
  domain: string,
  reason = 'This origin blocked federation access from this node.',
): Promise<void> {
  const normalizedDomain = normalizeNodeDomain(domain);
  const now = new Date();
  await quarantineOriginContent(normalizedDomain, now);
  await db.update(swarmNodes).set({
    remoteAccessDeniedAt: now,
    remoteAccessDeniedReason: reason.slice(0, 500),
    updatedAt: now,
  }).where(eq(swarmNodes.domain, normalizedDomain));
}

/** Remove an origin's caches while retaining scrubbed local repost history. */
export async function quarantineOriginContent(
  domain: string,
  unavailableAt = new Date(),
): Promise<void> {
  const normalizedDomain = normalizeNodeDomain(domain);
  await db.transaction(async (tx) => {
    await tx.delete(remotePosts).where(eq(remotePosts.nodeDomain, normalizedDomain));
    await tx.delete(remoteFeedStories).where(eq(remoteFeedStories.nodeDomain, normalizedDomain));
    await tx.delete(userSwarmLikes).where(eq(userSwarmLikes.nodeDomain, normalizedDomain));
    await tx.update(userSwarmReposts).set({
      content: '',
      authorDisplayName: null,
      authorAvatarUrl: null,
      likesCount: 0,
      repostsCount: 0,
      repliesCount: 0,
      linkPreviewUrl: null,
      linkPreviewTitle: null,
      linkPreviewDescription: null,
      linkPreviewImage: null,
      linkPreviewType: null,
      linkPreviewVideoUrl: null,
      linkPreviewMediaJson: null,
      mediaJson: null,
      originUnavailableAt: unavailableAt,
    }).where(eq(userSwarmReposts.nodeDomain, normalizedDomain));
  });
}

/** A later successful signed content read is proof that access was restored. */
export async function clearRemoteNodeAccessDenied(domain: string): Promise<void> {
  const normalizedDomain = normalizeNodeDomain(domain);
  await db.update(swarmNodes).set({
    remoteAccessDeniedAt: null,
    remoteAccessDeniedReason: null,
    updatedAt: new Date(),
  }).where(eq(swarmNodes.domain, normalizedDomain));
}
