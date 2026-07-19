/**
 * Swarm Timeline Endpoint
 * 
 * GET: Returns recent public posts from this node for the swarm timeline
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, posts, users, media, remoteReposts } from '@/db';
import { eq, desc, and, isNull, lt, inArray, like, notLike, sql } from 'drizzle-orm';
import { parseLinkPreviewMediaJson } from '@/lib/media/linkPreview';
import { attachRemoteRepostSummaries } from '@/lib/posts/remote-reposts';
import type { User } from '@/lib/types';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { redactSensitivePostForViewer } from '@/lib/nsfw/content-visibility';
import { hasStrictLocalUserOrigin } from '@/lib/swarm/local-user-origin';
import { isTrustedFederationRead } from '@/lib/swarm/signed-read';
import { parseBoundedInteger } from '@/lib/http/query';

export interface SwarmPost {
  id: string;
  content: string;
  createdAt: string;
  isReply?: boolean;
  replyToId?: string | null;
  swarmReplyToId?: string | null;
  repostOfId?: string | null;
  repostOf?: SwarmPost | null;
  repostedBy?: User[];
  repostedByCount?: number;
  feedActivityAt?: string;
  author: {
    handle: string;
    displayName: string;
    avatarUrl?: string;
    isNsfw: boolean;
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
  linkPreviewType?: 'card' | 'image' | 'gallery' | 'video';
  linkPreviewVideoUrl?: string;
  linkPreviewMedia?: Array<{ url: string; width?: number | null; height?: number | null; mimeType?: string | null }>;
}

interface TimelinePostRow {
  id: string;
  content: string;
  createdAt: Date;
  replyToId: string | null;
  swarmReplyToId: string | null;
  repostOfId: string | null;
  isNsfw: boolean;
  likesCount: number;
  repostsCount: number;
  repliesCount: number;
  linkPreviewUrl: string | null;
  linkPreviewTitle: string | null;
  linkPreviewDescription: string | null;
  linkPreviewImage: string | null;
  linkPreviewType: string | null;
  linkPreviewVideoUrl: string | null;
  linkPreviewMediaJson: string | null;
  authorHandle: string;
  authorDisplayName: string | null;
  authorAvatarUrl: string | null;
  authorIsNsfw: boolean;
  feedActivityAt?: Date;
}

interface LocalRepostRow {
  repostOfId: string | null;
  author: {
    id: string;
    handle: string;
    nodeId: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    isNsfw: boolean;
  };
}

function attachLocalRepostSummaries(
  swarmPosts: SwarmPost[],
  repostRows: LocalRepostRow[],
  nodeDomain: string,
): SwarmPost[] {
  const actorsByPostId = new Map<string, User[]>();

  for (const row of repostRows) {
    if (!row.repostOfId) continue;
    if (!hasStrictLocalUserOrigin(row.author)) continue;
    const actors = actorsByPostId.get(row.repostOfId) || [];
    const actor: User = {
      id: `swarm:${nodeDomain}:${row.author.handle}`,
      handle: row.author.handle,
      displayName: row.author.displayName || row.author.handle,
      avatarUrl: row.author.avatarUrl,
      isNsfw: row.author.isNsfw,
      nodeDomain,
    };
    if (!actors.some((candidate) => candidate.id === actor.id)) {
      actors.push(actor);
    }
    actorsByPostId.set(row.repostOfId, actors);
  }

  return swarmPosts.map((post) => {
    const localActors = actorsByPostId.get(post.id) || [];
    if (localActors.length === 0) return post;
    const existingActors = post.repostedBy || [];
    const existingIds = new Set(existingActors.map((actor) => actor.id));
    const repostedBy = [
      ...existingActors,
      ...localActors.filter((actor) => !existingIds.has(actor.id)),
    ];

    return {
      ...post,
      repostedBy,
      repostedByCount: Math.max(post.repostedByCount || 0, post.repostCount, repostedBy.length),
    };
  });
}

function buildSwarmPost(
  post: TimelinePostRow,
  mediaByPostId: Map<string, Array<{ url: string; mimeType?: string; altText?: string }>>,
  repostById: Map<string, SwarmPost>,
  nodeDomain: string,
  nodeIsNsfw: boolean
): SwarmPost {
  return {
    id: post.id,
    content: post.content,
    createdAt: post.createdAt.toISOString(),
    feedActivityAt: (post.feedActivityAt || post.createdAt).toISOString(),
    isReply: Boolean(post.replyToId || post.swarmReplyToId),
    replyToId: post.replyToId,
    swarmReplyToId: post.swarmReplyToId,
    repostOfId: post.repostOfId,
    repostOf: post.repostOfId ? repostById.get(post.repostOfId) || null : null,
    author: {
      handle: post.authorHandle,
      displayName: post.authorDisplayName || post.authorHandle,
      avatarUrl: post.authorAvatarUrl || undefined,
      isNsfw: post.authorIsNsfw,
    },
    nodeDomain,
    nodeIsNsfw,
    isNsfw: post.isNsfw || post.authorIsNsfw,
    likeCount: post.likesCount,
    repostCount: post.repostsCount,
    replyCount: post.repliesCount,
    media: mediaByPostId.get(post.id),
    linkPreviewUrl: post.linkPreviewUrl || undefined,
    linkPreviewTitle: post.linkPreviewTitle || undefined,
    linkPreviewDescription: post.linkPreviewDescription || undefined,
    linkPreviewImage: post.linkPreviewImage || undefined,
    linkPreviewType: (post.linkPreviewType as SwarmPost['linkPreviewType']) || undefined,
    linkPreviewVideoUrl: post.linkPreviewVideoUrl || undefined,
    linkPreviewMedia: parseLinkPreviewMediaJson(post.linkPreviewMediaJson),
  };
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
    const limit = parseBoundedInteger(searchParams.get('limit'), {
      defaultValue: 20,
      min: 1,
      max: 50,
    });

    const cursor = searchParams.get('cursor');
    const searchQuery = searchParams.get('q')?.trim() || '';
    if (searchQuery.length > 100) {
      return NextResponse.json({ error: 'Search query is too long' }, { status: 400 });
    }

    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    }

    const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost';

    const nodeIsNsfw = await requireLocalNodeNsfwClassification();
    const trustedRead = await isTrustedFederationRead(request);

    // Use query builder for better conditional logic
    // Only return posts from local users (not remote placeholder users)
    // Local posts may have apId if they've been federated, so we check nodeId instead
    const searchCondition = searchQuery
      ? like(posts.content, `%${searchQuery}%`)
      : undefined;
    let whereCondition = and(
      isNull(posts.replyToId), // Not a reply
      isNull(posts.swarmReplyToId), // Not a swarm reply
      eq(posts.isRemoved, false), // Not removed
      isNull(users.nodeId), // Local user (not from another swarm node)
      notLike(users.handle, '%@%'), // Cached remote placeholders may not have a nodeId
      sql`not exists (
        select 1 from ${remoteReposts}
        where ${remoteReposts.postId} = coalesce(${posts.repostOfId}, ${posts.id})
      )`,
      searchCondition,
    );

    const parsedCursorDate = cursor ? new Date(cursor) : null;
    const cursorDate = parsedCursorDate && !isNaN(parsedCursorDate.getTime())
      ? parsedCursorDate
      : null;

    if (cursorDate) {
      // Find the cursor post or use timestamp directly if passed as ISO string
      // Actually, for swarm, passing ISO timestamp is safer than ID because IDs are local UUIDs
      // Let's assume cursor is an ISO date string for swarm timeline
      whereCondition = and(whereCondition, lt(posts.createdAt, cursorDate));
    }

    // Get recent public posts (not replies, local users only, not removed)
    const recentPosts = await db
      .select({
        id: posts.id,
        content: posts.content,
        createdAt: posts.createdAt,
        replyToId: posts.replyToId,
        swarmReplyToId: posts.swarmReplyToId,
        repostOfId: posts.repostOfId,
        isNsfw: posts.isNsfw,
        likesCount: posts.likesCount,
        repostsCount: posts.repostsCount,
        repliesCount: posts.repliesCount,
        linkPreviewUrl: posts.linkPreviewUrl,
        linkPreviewTitle: posts.linkPreviewTitle,
        linkPreviewDescription: posts.linkPreviewDescription,
        linkPreviewImage: posts.linkPreviewImage,
        linkPreviewType: posts.linkPreviewType,
        linkPreviewVideoUrl: posts.linkPreviewVideoUrl,
        linkPreviewMediaJson: posts.linkPreviewMediaJson,
        authorHandle: users.handle,
        authorDisplayName: users.displayName,
        authorAvatarUrl: users.avatarUrl,
        authorIsNsfw: users.isNsfw,
        authorNodeId: users.nodeId,
      })
      .from(posts)
      .innerJoin(users, eq(posts.userId, users.id))
      .where(whereCondition)
      .orderBy(desc(posts.createdAt))
      .limit(limit);

    const latestRemoteActivityAt = sql<Date>`max(
      max(${remoteReposts.createdAt}),
      coalesce((
        select max("activity_posts"."created_at")
        from "posts" "activity_posts"
        where coalesce("activity_posts"."repost_of_id", "activity_posts"."id") = ${remoteReposts.postId}
          and "activity_posts"."is_removed" = 0
          and "activity_posts"."reply_to_id" is null
          and "activity_posts"."swarm_reply_to_id" is null
      ), 0)
    )`.mapWith(posts.createdAt);
    const remoteActivityQuery = db.select({
      postId: remoteReposts.postId,
      latestActivityAt: latestRemoteActivityAt,
    })
      .from(remoteReposts)
      .innerJoin(posts, eq(remoteReposts.postId, posts.id))
      .innerJoin(users, eq(posts.userId, users.id))
      .where(and(
        isNull(posts.replyToId),
        isNull(posts.swarmReplyToId),
        eq(posts.isRemoved, false),
        isNull(users.nodeId),
        notLike(users.handle, '%@%'),
        searchCondition,
      ))
      .groupBy(remoteReposts.postId)
      .orderBy(desc(latestRemoteActivityAt))
      .limit(limit);
    const remoteActivityRows = cursorDate
      ? await remoteActivityQuery.having(lt(latestRemoteActivityAt, cursorDate))
      : await remoteActivityQuery;
    const remoteActivityByPostId = new Map(
      remoteActivityRows.map((row) => [row.postId, row.latestActivityAt]),
    );
    const remoteStoryIds = remoteActivityRows.map((row) => row.postId);
    const remoteStoryPosts = remoteStoryIds.length > 0
      ? await db
          .select({
            id: posts.id,
            content: posts.content,
            createdAt: posts.createdAt,
            replyToId: posts.replyToId,
            swarmReplyToId: posts.swarmReplyToId,
            repostOfId: posts.repostOfId,
            isNsfw: posts.isNsfw,
            likesCount: posts.likesCount,
            repostsCount: posts.repostsCount,
            repliesCount: posts.repliesCount,
            linkPreviewUrl: posts.linkPreviewUrl,
            linkPreviewTitle: posts.linkPreviewTitle,
            linkPreviewDescription: posts.linkPreviewDescription,
            linkPreviewImage: posts.linkPreviewImage,
            linkPreviewType: posts.linkPreviewType,
            linkPreviewVideoUrl: posts.linkPreviewVideoUrl,
            linkPreviewMediaJson: posts.linkPreviewMediaJson,
            authorHandle: users.handle,
            authorDisplayName: users.displayName,
            authorAvatarUrl: users.avatarUrl,
            authorIsNsfw: users.isNsfw,
          })
          .from(posts)
          .innerJoin(users, eq(posts.userId, users.id))
          .where(and(
            inArray(posts.id, remoteStoryIds),
            isNull(users.nodeId),
            notLike(users.handle, '%@%'),
          ))
      : [];
    const selectedById = new Map<string, TimelinePostRow>();
    for (const post of [
      ...recentPosts.map((item) => ({ ...item, feedActivityAt: item.createdAt })),
      ...remoteStoryPosts.map((item) => ({
        ...item,
        feedActivityAt: remoteActivityByPostId.get(item.id) || item.createdAt,
      })),
    ]) {
      const existing = selectedById.get(post.id);
      if (!existing || (post.feedActivityAt || post.createdAt) > (existing.feedActivityAt || existing.createdAt)) {
        selectedById.set(post.id, post);
      }
    }
    const selectedPosts = Array.from(selectedById.values())
      .sort((a, b) =>
        (b.feedActivityAt || b.createdAt).getTime() - (a.feedActivityAt || a.createdAt).getTime())
      .slice(0, limit);

    console.log(`[Swarm Timeline API] Found ${selectedPosts.length} posts for ${nodeDomain}`);

    const repostIds = Array.from(new Set(
      selectedPosts
        .map(post => post.repostOfId)
        .filter((id): id is string => Boolean(id))
    ));

    const repostTargets = repostIds.length > 0
      ? await db
          .select({
            id: posts.id,
            content: posts.content,
            createdAt: posts.createdAt,
            replyToId: posts.replyToId,
            swarmReplyToId: posts.swarmReplyToId,
            repostOfId: posts.repostOfId,
            isNsfw: posts.isNsfw,
            likesCount: posts.likesCount,
            repostsCount: posts.repostsCount,
            repliesCount: posts.repliesCount,
            linkPreviewUrl: posts.linkPreviewUrl,
            linkPreviewTitle: posts.linkPreviewTitle,
            linkPreviewDescription: posts.linkPreviewDescription,
            linkPreviewImage: posts.linkPreviewImage,
            linkPreviewType: posts.linkPreviewType,
            linkPreviewVideoUrl: posts.linkPreviewVideoUrl,
            linkPreviewMediaJson: posts.linkPreviewMediaJson,
            authorHandle: users.handle,
            authorDisplayName: users.displayName,
            authorAvatarUrl: users.avatarUrl,
            authorIsNsfw: users.isNsfw,
          })
          .from(posts)
          .innerJoin(users, eq(posts.userId, users.id))
          .where(and(
            inArray(posts.id, repostIds),
            eq(posts.isRemoved, false),
            isNull(users.nodeId),
            notLike(users.handle, '%@%'),
          ))
      : [];

    const mediaPostIds = Array.from(new Set([
      ...recentPosts.map(post => post.id),
      ...remoteStoryPosts.map(post => post.id),
      ...repostTargets.map(post => post.id),
    ]));

    const mediaRows = mediaPostIds.length > 0
      ? await db
          .select({
            postId: media.postId,
            url: media.url,
            mimeType: media.mimeType,
            altText: media.altText,
          })
          .from(media)
          .where(inArray(media.postId, mediaPostIds))
      : [];

    const mediaByPostId = new Map<string, Array<{ url: string; mimeType?: string; altText?: string }>>();
    for (const item of mediaRows) {
      if (!item.postId) continue;
      const bucket = mediaByPostId.get(item.postId) || [];
      bucket.push({
        url: item.url,
        mimeType: item.mimeType || undefined,
        altText: item.altText || undefined,
      });
      mediaByPostId.set(item.postId, bucket);
    }

    const repostById = new Map<string, SwarmPost>();
    const summaryPostIds = Array.from(new Set([
      ...selectedPosts.map((post) => post.id),
      ...repostTargets.map((post) => post.id),
    ]));
    const remoteRepostRows = summaryPostIds.length > 0
      ? await db.query.remoteReposts.findMany({
          where: { postId: { in: summaryPostIds } },
          orderBy: (remoteReposts, { desc }) => [desc(remoteReposts.createdAt)],
        })
      : [];
    const localRepostRows = summaryPostIds.length > 0
      ? await db.query.posts.findMany({
          where: { AND: [{ repostOfId: { in: summaryPostIds } }, { isRemoved: false }] },
          with: { author: true },
          orderBy: (posts, { desc }) => [desc(posts.createdAt)],
        })
      : [];
    const summarizedRepostTargets = attachLocalRepostSummaries(
      attachRemoteRepostSummaries(
        repostTargets.map((post) =>
          buildSwarmPost(post, mediaByPostId, repostById, nodeDomain, nodeIsNsfw)),
        remoteRepostRows,
      ),
      localRepostRows,
      nodeDomain,
    );
    for (const post of summarizedRepostTargets) {
      repostById.set(post.id, post);
    }

    const swarmPosts = attachLocalRepostSummaries(
      attachRemoteRepostSummaries(
        selectedPosts.map(post =>
          buildSwarmPost(post, mediaByPostId, repostById, nodeDomain, nodeIsNsfw)
        ),
        remoteRepostRows,
      ),
      localRepostRows,
      nodeDomain,
    );
    const responsePosts = trustedRead
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
      posts: responsePosts,
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
