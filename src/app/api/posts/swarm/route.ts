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

    // Check user's NSFW preference
    let includeNsfw = false;
    try {
      const session = await getSession();
      includeNsfw = session?.user?.nsfwEnabled ?? false;
    } catch {
      includeNsfw = false;
    }

    // Fetch swarm timeline (no caching - user preferences vary)
    const timeline = await fetchSwarmTimeline(10, 15, { includeNsfw, cursor });

    const session = await getSession().catch(() => null);
    const viewer = session?.user;
    const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:3000';
    const allTimelinePosts = collectNestedSwarmPosts(timeline.posts as SwarmFeedPost[]);
    const likedPostIds = viewer
      ? await getViewerSwarmLikedPostIds(
          allTimelinePosts.map(post => ({
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
          allTimelinePosts.map(post => ({
            id: `swarm:${post.nodeDomain}:${post.id}`,
            nodeDomain: post.nodeDomain,
            originalPostId: post.id,
          })),
          viewer.id
        )
      : new Set<string>();

    return NextResponse.json({
      posts: applyInteractionFlags(timeline.posts as SwarmFeedPost[], likedPostIds, repostedPostIds),
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
