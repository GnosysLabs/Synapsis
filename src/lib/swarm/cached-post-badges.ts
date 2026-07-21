import { db, remotePosts } from '@/db';
import type { StuffboxBadge } from '@/lib/types';
import { and, inArray } from 'drizzle-orm';
import { verifyStuffboxBadgeOnPost } from '@/lib/stuffbox/badge';
import { parseRemoteTimelineResponse } from './remote-timeline-payload';

type BadgeableAuthor = {
  stuffboxBadge?: StuffboxBadge | null;
};

type BadgeablePost = {
  id: string;
  originalPostId?: string | null;
  nodeDomain?: string | null;
  author?: BadgeableAuthor | null;
  repostOf?: BadgeablePost | null;
  replyTo?: BadgeablePost | null;
};

type RemotePostKey = {
  nodeDomain: string;
  originalPostId: string;
};

function remotePostKey(post: BadgeablePost): RemotePostKey | null {
  if (!post.nodeDomain || !post.originalPostId) return null;
  return {
    nodeDomain: post.nodeDomain,
    originalPostId: post.originalPostId,
  };
}

function serializedKey(key: RemotePostKey): string {
  return `${key.nodeDomain}\u0000${key.originalPostId}`;
}

function collectRemotePostKeys(posts: BadgeablePost[]): RemotePostKey[] {
  const keys = new Map<string, RemotePostKey>();

  const visit = (post: BadgeablePost | null | undefined) => {
    if (!post) return;
    const key = remotePostKey(post);
    if (key) keys.set(serializedKey(key), key);
    visit(post.repostOf);
    visit(post.replyTo);
  };

  posts.forEach(visit);
  return [...keys.values()];
}

export function applyCachedStuffboxBadges<T extends BadgeablePost>(
  posts: T[],
  badgesByPost: ReadonlyMap<string, StuffboxBadge | null>,
): T[] {
  const apply = <TPost extends BadgeablePost>(post: TPost): TPost => {
    const key = remotePostKey(post);
    const cachedBadge = key ? badgesByPost.get(serializedKey(key)) : undefined;
    const hasCachedBadge = key ? badgesByPost.has(serializedKey(key)) : false;

    return {
      ...post,
      ...(post.author && hasCachedBadge
        ? { author: { ...post.author, stuffboxBadge: cachedBadge ?? null } }
        : {}),
      repostOf: post.repostOf ? apply(post.repostOf) : post.repostOf,
      replyTo: post.replyTo ? apply(post.replyTo) : post.replyTo,
    };
  };

  return posts.map(apply);
}

/**
 * Repost snapshots are deliberately durable, but their presentation metadata
 * can age. Merge the current, already-verified badge from the synchronized
 * remote post cache without adding network requests to feed rendering.
 */
export async function attachCachedStuffboxBadgesToPosts<T extends BadgeablePost>(
  posts: T[],
): Promise<T[]> {
  if (!db || posts.length === 0) return posts;

  const keys = collectRemotePostKeys(posts);
  if (keys.length === 0) return posts;

  const nodeDomains = [...new Set(keys.map((key) => key.nodeDomain))];
  const originalPostIds = [...new Set(keys.map((key) => key.originalPostId))];
  const requestedKeys = new Set(keys.map(serializedKey));
  const rows = await db.select({
    nodeDomain: remotePosts.nodeDomain,
    originalPostId: remotePosts.originalPostId,
    postJson: remotePosts.postJson,
  }).from(remotePosts).where(and(
    inArray(remotePosts.nodeDomain, nodeDomains),
    inArray(remotePosts.originalPostId, originalPostIds),
  ));

  const badgesByPost = new Map<string, StuffboxBadge | null>();
  await Promise.all(rows.map(async (row) => {
    if (!row.nodeDomain || !row.originalPostId || !row.postJson) return;
    const key = serializedKey({
      nodeDomain: row.nodeDomain,
      originalPostId: row.originalPostId,
    });
    if (!requestedKeys.has(key)) return;

    try {
      const parsedPost = parseRemoteTimelineResponse({
        posts: [JSON.parse(row.postJson)],
        nodeDomain: row.nodeDomain,
      }, row.nodeDomain).posts[0];
      if (!parsedPost || parsedPost.id !== row.originalPostId) return;
      const verifiedPost = await verifyStuffboxBadgeOnPost(parsedPost);
      badgesByPost.set(key, verifiedPost.author.stuffboxBadge ?? null);
    } catch {
      // A malformed cache row must never add presentation metadata.
    }
  }));

  return applyCachedStuffboxBadges(posts, badgesByPost);
}
