/**
 * Swarm Posts Endpoint
 * 
 * GET: Returns aggregated posts from across the swarm
 */

import { NextRequest, NextResponse } from 'next/server';
import { fetchSwarmTimeline } from '@/lib/swarm/timeline';
import { getSession } from '@/lib/auth';
import { getViewerSwarmLikedPostIds } from '@/lib/swarm/likes';
import { getViewerSwarmRepostedPostIds } from '@/lib/swarm/reposts';
import { shouldIncludeNsfwFeed } from '@/lib/nsfw/feed-access';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { db, likes, posts, userSwarmLikes, userSwarmReposts } from '@/db';
import { and, eq, inArray } from 'drizzle-orm';
import { isLocalSwarmDomain } from '@/lib/swarm/post-id';
import { redactSensitivePostForViewer } from '@/lib/nsfw/content-visibility';

type SwarmFeedPost = {
  id: string;
  nodeDomain: string;
  repostOf?: SwarmFeedPost | null;
  replyTo?: SwarmFeedPost | null;
  isLiked?: boolean;
  isReposted?: boolean;
};

function collectNestedSwarmPosts(posts: SwarmFeedPost[]): SwarmFeedPost[] {
  const collected: SwarmFeedPost[] = [];
  const seen = new Set<string>();

  const visit = (post: SwarmFeedPost | null | undefined) => {
    if (!post) return;
    const key = `${post.nodeDomain}:${post.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    collected.push(post);
    visit(post.repostOf);
    visit(post.replyTo);
  };

  posts.forEach(visit);
  return collected;
}

function applyInteractionFlags(
  posts: SwarmFeedPost[],
  likedIds: Set<string>,
  repostedIds: Set<string>
): SwarmFeedPost[] {
  return posts.map((post) => {
    const normalizedId = `swarm:${post.nodeDomain}:${post.id}`;
    return {
      ...post,
      isLiked: likedIds.has(normalizedId),
      isReposted: repostedIds.has(normalizedId),
      repostOf: post.repostOf ? applyInteractionFlags([post.repostOf], likedIds, repostedIds)[0] : post.repostOf,
      replyTo: post.replyTo ? applyInteractionFlags([post.replyTo], likedIds, repostedIds)[0] : post.replyTo,
    };
  });
}

/**
 * GET /api/posts/swarm
 * 
 * Returns aggregated posts from across the swarm network.
 * NSFW content is included based on user's nsfwEnabled setting.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const cursor = searchParams.get('cursor') || undefined;

    const session = await getSession().catch(() => null);
    const viewer = session?.user ?? null;
    const localNodeIsNsfw = await requireLocalNodeNsfwClassification();
    if (localNodeIsNsfw && !viewer) {
      return NextResponse.json({
        error: 'Sign in to this node to view its adult content feed',
        code: 'LOCAL_AUTH_REQUIRED',
      }, { status: 401 });
    }
    const includeNsfw = shouldIncludeNsfwFeed({
      viewer,
      localNodeIsNsfw,
    });

    // Fetch swarm timeline (no caching - user preferences vary)
    const timeline = await fetchSwarmTimeline(10, 15, { includeNsfw, cursor });

    const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';
    const allTimelinePosts = collectNestedSwarmPosts(timeline.posts as SwarmFeedPost[]);
    const localTimelinePosts = allTimelinePosts.filter(post =>
      isLocalSwarmDomain(post.nodeDomain, nodeDomain)
    );
    const remoteTimelinePosts = allTimelinePosts.filter(post =>
      !isLocalSwarmDomain(post.nodeDomain, nodeDomain)
    );
    const likedPostIds = viewer
      ? await getViewerSwarmLikedPostIds(
          remoteTimelinePosts.map(post => ({
            id: `swarm:${post.nodeDomain}:${post.id}`,
            nodeDomain: post.nodeDomain,
            originalPostId: post.id,
          })),
          viewer.handle,
          nodeDomain
        )
      : new Set<string>();
    const repostedPostIds = viewer
      ? await getViewerSwarmRepostedPostIds(
          remoteTimelinePosts.map(post => ({
            id: `swarm:${post.nodeDomain}:${post.id}`,
            nodeDomain: post.nodeDomain,
            originalPostId: post.id,
          })),
          viewer.id
        )
      : new Set<string>();

    if (viewer && localTimelinePosts.length > 0) {
      const localPostIds = Array.from(new Set(localTimelinePosts.map(post => post.id)));
      const [viewerLikes, viewerReposts, legacySameNodeLikes, legacySameNodeReposts] = await Promise.all([
        db.select({ postId: likes.postId })
          .from(likes)
          .where(and(eq(likes.userId, viewer.id), inArray(likes.postId, localPostIds))),
        db.select({ repostOfId: posts.repostOfId })
          .from(posts)
          .where(and(
            eq(posts.userId, viewer.id),
            inArray(posts.repostOfId, localPostIds),
            eq(posts.isRemoved, false),
          )),
        db.select({ originalPostId: userSwarmLikes.originalPostId })
          .from(userSwarmLikes)
          .where(and(
            eq(userSwarmLikes.userId, viewer.id),
            eq(userSwarmLikes.nodeDomain, nodeDomain),
            inArray(userSwarmLikes.originalPostId, localPostIds),
          )),
        db.select({ originalPostId: userSwarmReposts.originalPostId })
          .from(userSwarmReposts)
          .where(and(
            eq(userSwarmReposts.userId, viewer.id),
            eq(userSwarmReposts.nodeDomain, nodeDomain),
            inArray(userSwarmReposts.originalPostId, localPostIds),
          )),
      ]);

      const localDomainByPostId = new Map(localTimelinePosts.map(post => [post.id, post.nodeDomain]));
      for (const row of viewerLikes) {
        const domain = localDomainByPostId.get(row.postId);
        if (domain) likedPostIds.add(`swarm:${domain}:${row.postId}`);
      }
      for (const row of viewerReposts) {
        if (!row.repostOfId) continue;
        const domain = localDomainByPostId.get(row.repostOfId);
        if (domain) repostedPostIds.add(`swarm:${domain}:${row.repostOfId}`);
      }
      for (const row of legacySameNodeLikes) {
        const domain = localDomainByPostId.get(row.originalPostId);
        if (domain) likedPostIds.add(`swarm:${domain}:${row.originalPostId}`);
      }
      for (const row of legacySameNodeReposts) {
        const domain = localDomainByPostId.get(row.originalPostId);
        if (domain) repostedPostIds.add(`swarm:${domain}:${row.originalPostId}`);
      }
    }

    const postsWithInteractionFlags = applyInteractionFlags(
      timeline.posts as SwarmFeedPost[],
      likedPostIds,
      repostedPostIds,
    );
    const serializedPosts = postsWithInteractionFlags.map((post) => redactSensitivePostForViewer(
      post as unknown as Record<string, unknown>,
      {
        canViewSensitive: includeNsfw,
        localNodeDomain: nodeDomain,
        localNodeIsNsfw,
      },
    ));

    return NextResponse.json({
      posts: serializedPosts,
      sources: timeline.sources,
      cached: false,
      fetchedAt: timeline.fetchedAt,
      // Debug info
      debug: {
        includeNsfw,
        sourceCount: timeline.sources.length,
        totalPostsBeforeFilter: timeline.sources.reduce((sum, s) => sum + s.postCount, 0),
        postsAfterFilter: timeline.posts.length,
      },
    });
  } catch (error) {
    console.error('Swarm posts error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch swarm posts' },
      { status: 500 }
    );
  }
}
