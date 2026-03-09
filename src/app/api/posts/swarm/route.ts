/**
 * Swarm Posts Endpoint
 * 
 * GET: Returns aggregated posts from across the swarm
 */

import { NextRequest, NextResponse } from 'next/server';
import { fetchSwarmTimeline } from '@/lib/swarm/timeline';
import { getSession } from '@/lib/auth';
import { getViewerSwarmLikedPostIds } from '@/lib/swarm/likes';

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
    const likedPostIds = viewer
      ? await getViewerSwarmLikedPostIds(
          timeline.posts.map(post => ({
            id: `swarm:${post.nodeDomain}:${post.id}`,
            nodeDomain: post.nodeDomain,
            originalPostId: post.id,
          })),
          viewer.handle,
          nodeDomain
        )
      : new Set<string>();

    return NextResponse.json({
      posts: timeline.posts.map(post => ({
        ...post,
        isLiked: likedPostIds.has(`swarm:${post.nodeDomain}:${post.id}`),
      })),
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
