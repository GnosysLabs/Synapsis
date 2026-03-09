/**
 * Swarm User Profile Endpoint
 * 
 * GET: Returns a user's profile and posts for swarm requests
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, posts, users, media, nodes } from '@/db';
import { eq, desc, and, isNull } from 'drizzle-orm';

export interface SwarmUserProfile {
  handle: string;
  displayName: string;
  bio?: string;
  avatarUrl?: string;
  headerUrl?: string;
  website?: string;
  followersCount: number;
  followingCount: number;
  postsCount: number;
  createdAt: string;
  isBot?: boolean;
  botOwnerHandle?: string; // Handle of the bot's owner (e.g., "user" or "user@domain")
  nodeDomain: string;
  publicKey?: string; // Signing key for verifying actions
  did?: string;
}

export interface SwarmUserPost {
  id: string;
  content: string;
  createdAt: string;
  isNsfw: boolean;
  likesCount: number;
  repostsCount: number;
  repliesCount: number;
  media?: { url: string; mimeType?: string; altText?: string }[];
  linkPreviewUrl?: string;
  linkPreviewTitle?: string;
  linkPreviewDescription?: string;
  linkPreviewImage?: string;
}

type RouteContext = { params: Promise<{ handle: string }> };

/**
 * GET /api/swarm/users/[handle]
 * 
 * Returns a user's profile and recent posts.
 * Used by other nodes to display remote user profiles.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { handle } = await context.params;
    const cleanHandle = handle.toLowerCase().replace(/^@/, '');
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '25'), 50);

    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    }

    const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost';

    // Find the user
    const user = await db.query.users.findFirst({
      where: eq(users.handle, cleanHandle),
      with: {
        botOwner: true, // Include bot owner if this is a bot
      },
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (user.isSuspended) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Build profile response
    const profile: SwarmUserProfile = {
      handle: user.handle,
      displayName: user.displayName || user.handle,
      bio: user.bio || undefined,
      avatarUrl: user.avatarUrl || undefined,
      headerUrl: user.headerUrl || undefined,
      website: user.website || undefined,
      followersCount: user.followersCount,
      followingCount: user.followingCount,
      postsCount: user.postsCount,
      createdAt: user.createdAt.toISOString(),
      isBot: user.isBot || undefined,
      botOwnerHandle: user.isBot && user.botOwner ? user.botOwner.handle : undefined,
      nodeDomain,
      publicKey: user.publicKey, // Expose signing key
      did: user.did || undefined,
    };

    // Get user's recent posts
    const userPosts = await db
      .select({
        id: posts.id,
        content: posts.content,
        createdAt: posts.createdAt,
        isNsfw: posts.isNsfw,
        likesCount: posts.likesCount,
        repostsCount: posts.repostsCount,
        repliesCount: posts.repliesCount,
        linkPreviewUrl: posts.linkPreviewUrl,
        linkPreviewTitle: posts.linkPreviewTitle,
        linkPreviewDescription: posts.linkPreviewDescription,
        linkPreviewImage: posts.linkPreviewImage,
      })
      .from(posts)
      .where(
        and(
          eq(posts.userId, user.id),
          eq(posts.isRemoved, false),
          isNull(posts.replyToId),
          isNull(posts.swarmReplyToId)
        )
      )
      .orderBy(desc(posts.createdAt))
      .limit(limit);

    // Fetch media for each post
    const swarmPosts: SwarmUserPost[] = [];

    for (const post of userPosts) {
      const postMedia = await db
        .select({ url: media.url, mimeType: media.mimeType, altText: media.altText })
        .from(media)
        .where(eq(media.postId, post.id));

      swarmPosts.push({
        id: post.id,
        content: post.content,
        createdAt: post.createdAt.toISOString(),
        isNsfw: post.isNsfw,
        likesCount: post.likesCount,
        repostsCount: post.repostsCount,
        repliesCount: post.repliesCount,
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
      profile,
      posts: swarmPosts,
      nodeDomain,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Swarm user profile error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch user profile' },
      { status: 500 }
    );
  }
}
