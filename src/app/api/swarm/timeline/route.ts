/**
 * Swarm Timeline Endpoint
 * 
 * GET: Returns recent public posts from this node for the swarm timeline
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, posts, users, media, nodes } from '@/db';
import { eq, desc, and, isNull, lt, sql } from 'drizzle-orm';

export interface SwarmPost {
  id: string;
  content: string;
  createdAt: string;
  isReply?: boolean;
  replyToId?: string | null;
  swarmReplyToId?: string | null;
  author: {
    handle: string;
    displayName: string;
    avatarUrl?: string;
    isNsfw: boolean;
    isBot?: boolean;
  };
  nodeDomain: string;
  nodeIsNsfw: boolean;
  isNsfw: boolean;
  likeCount: number;
  repostCount: number;
  replyCount: number;
  media?: { url: string; mimeType?: string; altText?: string }[];
  // Link preview
  linkPreviewUrl?: string;
  linkPreviewTitle?: string;
  linkPreviewDescription?: string;
  linkPreviewImage?: string;
}

/**
 * GET /api/swarm/timeline
 * 
 * Returns recent public posts from this node.
 * Used by other nodes to build the swarm-wide timeline.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 50);

    const cursor = searchParams.get('cursor');

    if (!db) {
      return NextResponse.json({ posts: [], nodeDomain: '', nodeIsNsfw: false });
    }

    const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost';

    // Get node NSFW status
    const node = await db.query.nodes.findFirst({
      where: eq(nodes.domain, nodeDomain),
    });
    const nodeIsNsfw = node?.isNsfw ?? false;

    // Use query builder for better conditional logic
    // Only return posts from local users (not remote placeholder users)
    // Local posts may have apId if they've been federated, so we check nodeId instead
    let whereCondition = and(
      isNull(posts.replyToId), // Not a reply
      isNull(posts.swarmReplyToId), // Not a swarm reply
      eq(posts.isRemoved, false), // Not removed
      isNull(users.nodeId) // Local user (not from another swarm node)
    );

    if (cursor) {
      // Find the cursor post or use timestamp directly if passed as ISO string
      // Actually, for swarm, passing ISO timestamp is safer than ID because IDs are local UUIDs
      // Let's assume cursor is an ISO date string for swarm timeline
      const cursorDate = new Date(cursor);
      if (!isNaN(cursorDate.getTime())) {
        whereCondition = and(whereCondition, lt(posts.createdAt, cursorDate));
      }
    }

    // Get recent public posts (not replies, local users only, not removed)
    const recentPosts = await db
      .select({
        id: posts.id,
        content: posts.content,
        createdAt: posts.createdAt,
        replyToId: posts.replyToId,
        swarmReplyToId: posts.swarmReplyToId,
        isNsfw: posts.isNsfw,
        likesCount: posts.likesCount,
        repostsCount: posts.repostsCount,
        repliesCount: posts.repliesCount,
        linkPreviewUrl: posts.linkPreviewUrl,
        linkPreviewTitle: posts.linkPreviewTitle,
        linkPreviewDescription: posts.linkPreviewDescription,
        linkPreviewImage: posts.linkPreviewImage,
        authorHandle: users.handle,
        authorDisplayName: users.displayName,
        authorAvatarUrl: users.avatarUrl,
        authorIsNsfw: users.isNsfw,
        authorIsBot: users.isBot,
        authorNodeId: users.nodeId,
      })
      .from(posts)
      .innerJoin(users, eq(posts.userId, users.id))
      .where(whereCondition)
      .orderBy(desc(posts.createdAt))
      .limit(limit);

    console.log(`[Swarm Timeline API] Found ${recentPosts.length} posts for ${nodeDomain}`);

    // Fetch media for each post
    const swarmPosts: SwarmPost[] = [];

    for (const post of recentPosts) {
      const postMedia = await db
        .select({ url: media.url, mimeType: media.mimeType, altText: media.altText })
        .from(media)
        .where(eq(media.postId, post.id));

      swarmPosts.push({
        id: post.id,
        content: post.content,
        createdAt: post.createdAt.toISOString(),
        isReply: Boolean(post.replyToId || post.swarmReplyToId),
        replyToId: post.replyToId,
        swarmReplyToId: post.swarmReplyToId,
        author: {
          handle: post.authorHandle,
          displayName: post.authorDisplayName || post.authorHandle,
          avatarUrl: post.authorAvatarUrl || undefined,
          isNsfw: post.authorIsNsfw,
          isBot: post.authorIsBot,
        },
        nodeDomain,
        nodeIsNsfw,
        isNsfw: post.isNsfw || post.authorIsNsfw, // Post-level NSFW (not node-level)
        likeCount: post.likesCount,
        repostCount: post.repostsCount,
        replyCount: post.repliesCount,
        media: postMedia.length > 0 ? postMedia.map(m => ({
          url: m.url,
          mimeType: m.mimeType || undefined,
          altText: m.altText || undefined,
        })) : undefined,
        linkPreviewUrl: post.linkPreviewUrl || undefined,
        linkPreviewTitle: post.linkPreviewTitle || undefined,
        linkPreviewDescription: post.linkPreviewDescription || undefined,
        linkPreviewImage: post.linkPreviewImage || undefined,
      });
    }

    return NextResponse.json({
      posts: swarmPosts,
      nodeDomain,
      nodeIsNsfw,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Swarm timeline error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch timeline' },
      { status: 500 }
    );
  }
}
