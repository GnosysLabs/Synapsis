/**
 * Swarm User Profile Endpoint
 * 
 * GET: Returns a user's profile and posts for swarm requests
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, media, posts, users, userSwarmReposts } from '@/db';
import { parseLinkPreviewMediaJson } from '@/lib/media/linkPreview';
import { attachRemoteRepostSummaries } from '@/lib/posts/remote-reposts';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { redactSensitivePostForViewer } from '@/lib/nsfw/content-visibility';
import { hasStrictLocalUserOrigin } from '@/lib/swarm/local-user-origin';
import { authorizeFederationRead, federationReadFailureResponse } from '@/lib/swarm/signed-read';
import { parseBoundedInteger } from '@/lib/http/query';
import { ORIGIN_UNAVAILABLE_CONTENT } from '@/lib/swarm/remote-access-protocol';
import {
  requireCanonicalAccountHomeDomain,
  resolveAccountAddress,
} from '@/lib/identity/account-address';

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
  isNsfw: boolean;
  nodeIsNsfw: boolean;
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
    isNsfw?: boolean;
    nodeIsNsfw?: boolean;
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
  repostedBy?: Array<{
    id: string;
    handle: string;
    displayName: string;
    avatarUrl?: string | null;
    isNsfw?: boolean;
    nodeIsNsfw?: boolean;
    nodeDomain?: string | null;
  }>;
  repostedByCount?: number;
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

type LocalPostWithRelations = typeof posts.$inferSelect & {
  author: typeof users.$inferSelect | null;
  media: Array<typeof media.$inferSelect>;
  repostOf?: LocalPostWithRelations | null;
};

function mapLocalPostToSwarmPost(post: LocalPostWithRelations, nodeDomain: string, nodeIsNsfw: boolean): SwarmUserPost {
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
      isNsfw: post.author.isNsfw,
      nodeIsNsfw,
      nodeDomain,
    } : undefined,
    media: post.media.map((item) => ({
      url: item.url,
      mimeType: item.mimeType || undefined,
      altText: item.altText || undefined,
    })),
    linkPreviewUrl: post.linkPreviewUrl || undefined,
    linkPreviewTitle: post.linkPreviewTitle || undefined,
    linkPreviewDescription: post.linkPreviewDescription || undefined,
    linkPreviewImage: post.linkPreviewImage || undefined,
    linkPreviewType: post.linkPreviewType === 'card' || post.linkPreviewType === 'image' || post.linkPreviewType === 'gallery' || post.linkPreviewType === 'video'
      ? post.linkPreviewType
      : undefined,
    linkPreviewVideoUrl: post.linkPreviewVideoUrl || undefined,
    linkPreviewMedia: parseLinkPreviewMediaJson(post.linkPreviewMediaJson),
    repostOfId: post.repostOfId || undefined,
    repostOf: post.repostOf ? mapLocalPostToSwarmPost(post.repostOf, nodeDomain, nodeIsNsfw) : undefined,
  };
}

function mapUserSwarmRepostToSwarmPost(
  row: typeof userSwarmReposts.$inferSelect,
  author: typeof users.$inferSelect,
  nodeDomain: string,
  nodeIsNsfw: boolean
): SwarmUserPost {
  const originUnavailable = Boolean(row.originUnavailableAt);
  return {
    id: row.id,
    originalPostId: row.id,
    content: '',
    createdAt: row.repostedAt.toISOString(),
    isNsfw: author.isNsfw,
    likesCount: 0,
    repostsCount: 0,
    repliesCount: 0,
    nodeDomain,
    author: {
      handle: author.handle,
      displayName: author.displayName || author.handle,
      avatarUrl: author.avatarUrl || undefined,
      isNsfw: author.isNsfw,
      nodeIsNsfw,
      nodeDomain,
    },
    repostOfId: row.originalPostId,
    repostOf: {
      id: row.originalPostId,
      originalPostId: row.originalPostId,
      content: originUnavailable ? ORIGIN_UNAVAILABLE_CONTENT : row.content,
      originUnavailable,
      createdAt: row.postCreatedAt.toISOString(),
      // These legacy snapshots predate classifier persistence. Treat the
      // unknown remote original as sensitive instead of inventing `false`.
      isNsfw: true,
      likesCount: row.likesCount,
      repostsCount: row.repostsCount,
      repliesCount: row.repliesCount,
      nodeDomain: row.nodeDomain,
      author: {
        handle: resolveAccountAddress(row.authorHandle, row.nodeDomain)?.canonical || row.authorHandle,
        displayName: row.authorDisplayName || row.authorHandle,
        avatarUrl: row.authorAvatarUrl || undefined,
        isNsfw: true,
        nodeIsNsfw: true,
        nodeDomain: row.nodeDomain,
      },
      media: originUnavailable ? [] : parseMediaJson(row.mediaJson),
      linkPreviewUrl: originUnavailable ? undefined : row.linkPreviewUrl || undefined,
      linkPreviewTitle: originUnavailable ? undefined : row.linkPreviewTitle || undefined,
      linkPreviewDescription: originUnavailable ? undefined : row.linkPreviewDescription || undefined,
      linkPreviewImage: originUnavailable ? undefined : row.linkPreviewImage || undefined,
      linkPreviewType: originUnavailable ? undefined : (row.linkPreviewType as SwarmUserPost['linkPreviewType']) || undefined,
      linkPreviewVideoUrl: originUnavailable ? undefined : row.linkPreviewVideoUrl || undefined,
      linkPreviewMedia: originUnavailable ? [] : parseLinkPreviewMediaJson(row.linkPreviewMediaJson),
    } as SwarmUserPost & { originUnavailable?: boolean },
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
    const readAuthorization = await authorizeFederationRead(request);
    if (!readAuthorization.ok) return federationReadFailureResponse(readAuthorization);
    const { handle } = await context.params;
    const cleanHandle = handle.toLowerCase().replace(/^@/, '');
    if (!/^[a-z0-9_]{1,64}$/.test(cleanHandle)) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    const { searchParams } = new URL(request.url);
    const limit = parseBoundedInteger(searchParams.get('limit'), {
      defaultValue: 25,
      min: 0,
      max: 50,
    });
    const cursorValue = searchParams.get('cursor');
    const parsedCursorDate = cursorValue ? new Date(cursorValue) : null;
    const cursorDate = parsedCursorDate && !Number.isNaN(parsedCursorDate.getTime())
      ? parsedCursorDate
      : null;

    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    }

    const nodeDomain = requireCanonicalAccountHomeDomain(
      process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
    );
    const localAddress = resolveAccountAddress(cleanHandle, nodeDomain);
    if (!localAddress || localAddress.homeDomain !== nodeDomain) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    const nodeIsNsfw = await requireLocalNodeNsfwClassification();
    const trustedRead = true;

    // Find the user
    const user = await db.query.users.findFirst({
      where: {
        AND: [
          { username: localAddress.username },
          { homeDomain: nodeDomain },
          { isLocalAccount: true },
        ],
      },
    });

    if (!user || !hasStrictLocalUserOrigin(user)) {
      const tombstone = await db.query.swarmAccountTombstones.findFirst({
        where: { handle: localAddress.canonical },
      });
      if (tombstone && trustedRead) {
        return NextResponse.json({
          deleted: true,
          handle: tombstone.handle,
          deletedAt: tombstone.deletedAt.toISOString(),
        }, { status: 410 });
      }
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
      isNsfw: user.isNsfw,
      nodeIsNsfw,
      nodeDomain,
      publicKey: user.publicKey, // Expose signing key
      did: user.did || undefined,
    };

    const localPosts = await db.query.posts.findMany({
      where: {
        AND: [
          { userId: user.id },
          { isRemoved: false },
          { replyToId: { isNull: true } },
          { swarmReplyToId: { isNull: true } },
          ...(cursorDate ? [{ createdAt: { lt: cursorDate } }] : []),
        ],
      },
      with: profilePostRelations,
      orderBy: (posts, { desc }) => [desc(posts.createdAt)],
      limit: limit * 2,
    });
    const remoteRepostSummaries = localPosts.length > 0
      ? await db.query.remoteReposts.findMany({
          where: { postId: { in: localPosts.map((post) => post.id) } },
          orderBy: (remoteReposts, { desc }) => [desc(remoteReposts.createdAt)],
        })
      : [];
    const summarizedLocalPosts = attachRemoteRepostSummaries(
      localPosts.map((post) => mapLocalPostToSwarmPost(post, nodeDomain, nodeIsNsfw)),
      remoteRepostSummaries,
    );

    const remoteRepostRows = await db.query.userSwarmReposts.findMany({
      where: {
        userId: user.id,
        ...(cursorDate ? { repostedAt: { lt: cursorDate } } : {}),
      },
      orderBy: (userSwarmReposts, { desc }) => [desc(userSwarmReposts.repostedAt)],
      limit: limit * 2,
    });

    const swarmPosts: SwarmUserPost[] = [
      ...summarizedLocalPosts,
      ...remoteRepostRows.map((row) => mapUserSwarmRepostToSwarmPost(row, user, nodeDomain, nodeIsNsfw)),
    ]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
    const profileRestricted = !trustedRead && (user.isNsfw || nodeIsNsfw);
    const responseProfile: SwarmUserProfile & { nsfwRestricted?: boolean } = profileRestricted
      ? {
          ...profile,
          displayName: profile.handle,
          bio: undefined,
          avatarUrl: undefined,
          headerUrl: undefined,
          website: undefined,
          nsfwRestricted: true,
        }
      : profile;
    const responsePosts = profileRestricted
      ? []
      : trustedRead
        ? swarmPosts
        : swarmPosts
            .map((post) => redactSensitivePostForViewer(
              post as unknown as Record<string, unknown>,
              {
                canViewSensitive: false,
                localNodeDomain: nodeDomain,
                localNodeIsNsfw: nodeIsNsfw,
              },
            ))
            .filter((post) => post.sensitiveContentRestricted !== true);

    return NextResponse.json({
      profile: responseProfile,
      posts: responsePosts,
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
