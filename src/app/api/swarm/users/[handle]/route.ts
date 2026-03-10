/**
 * Swarm User Profile Endpoint
 * 
 * GET: Returns a user's profile and posts for swarm requests
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, posts, users, userSwarmReposts } from '@/db';
import { eq, desc, and, isNull } from 'drizzle-orm';
import { parseLinkPreviewMediaJson } from '@/lib/media/linkPreview';

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
  originalPostId?: string;
  content: string;
  createdAt: string;
  isNsfw: boolean;
  likesCount: number;
  repostsCount: number;
  repliesCount: number;
  nodeDomain?: string;
  author?: {
    handle: string;
    displayName?: string;
    avatarUrl?: string;
    isBot?: boolean;
    nodeDomain?: string;
  };
  media?: { url: string; mimeType?: string; altText?: string }[];
  linkPreviewUrl?: string;
  linkPreviewTitle?: string;
  linkPreviewDescription?: string;
  linkPreviewImage?: string;
  linkPreviewType?: 'card' | 'image' | 'gallery' | 'video';
  linkPreviewVideoUrl?: string;
  linkPreviewMedia?: Array<{ url: string; width?: number | null; height?: number | null; mimeType?: string | null }>;
  repostOfId?: string;
  repostOf?: SwarmUserPost | null;
}

type RouteContext = { params: Promise<{ handle: string }> };

const profilePostRelations = {
  author: true,
  media: true,
  repostOf: {
    with: {
      author: true,
      media: true,
    },
  },
} as const;

function parseMediaJson(mediaJson: string | null) {
  if (!mediaJson) {
    return [];
  }

  try {
    return JSON.parse(mediaJson);
  } catch {
    return [];
  }
}

function mapLocalPostToSwarmPost(post: any, nodeDomain: string): SwarmUserPost {
  return {
    id: post.id,
    originalPostId: post.id,
    content: post.content,
    createdAt: post.createdAt.toISOString(),
    isNsfw: post.isNsfw,
    likesCount: post.likesCount,
    repostsCount: post.repostsCount,
    repliesCount: post.repliesCount,
    nodeDomain,
    author: post.author ? {
      handle: post.author.handle,
      displayName: post.author.displayName || post.author.handle,
      avatarUrl: post.author.avatarUrl || undefined,
      isBot: post.author.isBot || undefined,
      nodeDomain,
    } : undefined,
    media: (post.media || []).map((item: any) => ({
      url: item.url,
      mimeType: item.mimeType || undefined,
      altText: item.altText || undefined,
    })),
    linkPreviewUrl: post.linkPreviewUrl || undefined,
    linkPreviewTitle: post.linkPreviewTitle || undefined,
    linkPreviewDescription: post.linkPreviewDescription || undefined,
    linkPreviewImage: post.linkPreviewImage || undefined,
    linkPreviewType: post.linkPreviewType || undefined,
    linkPreviewVideoUrl: post.linkPreviewVideoUrl || undefined,
    linkPreviewMedia: parseLinkPreviewMediaJson(post.linkPreviewMediaJson),
    repostOfId: post.repostOfId || undefined,
    repostOf: post.repostOf ? mapLocalPostToSwarmPost(post.repostOf, nodeDomain) : undefined,
  };
}

function mapUserSwarmRepostToSwarmPost(
  row: typeof userSwarmReposts.$inferSelect,
  author: typeof users.$inferSelect,
  nodeDomain: string
): SwarmUserPost {
  return {
    id: row.id,
    originalPostId: row.id,
    content: '',
    createdAt: row.repostedAt.toISOString(),
    isNsfw: false,
    likesCount: 0,
    repostsCount: 0,
    repliesCount: 0,
    nodeDomain,
    author: {
      handle: author.handle,
      displayName: author.displayName || author.handle,
      avatarUrl: author.avatarUrl || undefined,
      isBot: author.isBot || undefined,
      nodeDomain,
    },
    repostOfId: row.originalPostId,
    repostOf: {
      id: row.originalPostId,
      originalPostId: row.originalPostId,
      content: row.content,
      createdAt: row.postCreatedAt.toISOString(),
      isNsfw: false,
      likesCount: row.likesCount,
      repostsCount: row.repostsCount,
      repliesCount: row.repliesCount,
      nodeDomain: row.nodeDomain,
      author: {
        handle: row.authorHandle.includes('@') ? row.authorHandle : `${row.authorHandle}@${row.nodeDomain}`,
        displayName: row.authorDisplayName || row.authorHandle,
        avatarUrl: row.authorAvatarUrl || undefined,
        nodeDomain: row.nodeDomain,
      },
      media: parseMediaJson(row.mediaJson),
      linkPreviewUrl: row.linkPreviewUrl || undefined,
      linkPreviewTitle: row.linkPreviewTitle || undefined,
      linkPreviewDescription: row.linkPreviewDescription || undefined,
      linkPreviewImage: row.linkPreviewImage || undefined,
      linkPreviewType: (row.linkPreviewType as SwarmUserPost['linkPreviewType']) || undefined,
      linkPreviewVideoUrl: row.linkPreviewVideoUrl || undefined,
      linkPreviewMedia: parseLinkPreviewMediaJson(row.linkPreviewMediaJson),
    },
  };
}

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

    const localPosts = await db.query.posts.findMany({
      where: and(
        eq(posts.userId, user.id),
        eq(posts.isRemoved, false),
        isNull(posts.replyToId),
        isNull(posts.swarmReplyToId)
      ),
      with: profilePostRelations,
      orderBy: [desc(posts.createdAt)],
      limit: limit * 2,
    });

    const remoteRepostRows = await db.query.userSwarmReposts.findMany({
      where: eq(userSwarmReposts.userId, user.id),
      orderBy: [desc(userSwarmReposts.repostedAt)],
      limit: limit * 2,
    });

    const swarmPosts: SwarmUserPost[] = [
      ...localPosts.map((post) => mapLocalPostToSwarmPost(post, nodeDomain)),
      ...remoteRepostRows.map((row) => mapUserSwarmRepostToSwarmPost(row, user, nodeDomain)),
    ]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);

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
