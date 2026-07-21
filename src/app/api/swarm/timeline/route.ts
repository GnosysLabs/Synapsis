/**
 * Swarm Timeline Endpoint
 * 
 * GET: Returns recent public posts from this node for the swarm timeline
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  db,
  feedStories,
  media,
  posts,
  swarmAccountTombstones,
  swarmPostChanges,
  users,
} from '@/db';
import { eq, asc, desc, and, gt, isNull, lt, inArray, notLike, or } from 'drizzle-orm';
import { parseLinkPreviewMediaJson } from '@/lib/media/linkPreview';
import { attachRemoteRepostSummaries } from '@/lib/posts/remote-reposts';
import type { User } from '@/lib/types';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { redactSensitivePostForViewer } from '@/lib/nsfw/content-visibility';
import { hasStrictLocalUserOrigin } from '@/lib/swarm/local-user-origin';
import { authorizeFederationRead, federationReadFailureResponse } from '@/lib/swarm/signed-read';
import { parseBoundedInteger } from '@/lib/http/query';
import { searchIndexedPostIds } from '@/lib/search/post-index';
import { createSignedChangeBundle } from '@/lib/swarm/change-bundle';
import { getPublicSwarmDomain } from '@/lib/swarm/node-domain';

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
  originUnavailable?: boolean;
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

export interface SwarmPostChange {
  sequence: number;
  type: 'upsert' | 'delete';
  postId: string;
  changedAt: string;
  post?: SwarmPost;
}

export interface SwarmAccountDeletion {
  sequence: number;
  handle: string;
  did: string;
  deletedAt: string;
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
    const readAuthorization = await authorizeFederationRead(request);
    if (!readAuthorization.ok) return federationReadFailureResponse(readAuthorization);
    const { searchParams } = new URL(request.url);
    const limit = parseBoundedInteger(searchParams.get('limit'), {
      defaultValue: 20,
      min: 1,
      max: 50,
    });

    const cursor = searchParams.get('cursor');
    const since = searchParams.get('since');
    const sinceId = searchParams.get('sinceId')?.slice(0, 512) || null;
    const changesSinceRaw = searchParams.get('changesSince');
    const changesSince = changesSinceRaw === null ? null : Number(changesSinceRaw);
    if (changesSinceRaw !== null && (!Number.isSafeInteger(changesSince) || changesSince! < 0)) {
      return NextResponse.json({ error: 'Invalid changes cursor' }, { status: 400 });
    }
    const accountsSinceRaw = searchParams.get('accountsSince');
    const accountsSince = accountsSinceRaw === null ? null : Number(accountsSinceRaw);
    if (accountsSinceRaw !== null && (!Number.isSafeInteger(accountsSince) || accountsSince! < 0)) {
      return NextResponse.json({ error: 'Invalid account changes cursor' }, { status: 400 });
    }
    const searchQuery = searchParams.get('q')?.trim() || '';
    if (searchQuery.length > 100) {
      return NextResponse.json({ error: 'Search query is too long' }, { status: 400 });
    }

    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    }

    const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost';

    const nodeIsNsfw = await requireLocalNodeNsfwClassification();
    const trustedRead = true;
    // Capture the snapshot boundary before reading the snapshot. A concurrent
    // later mutation will then be replayed (safe) rather than skipped.
    const contentClockBoundary = trustedRead
      ? Number((await db.query.swarmContentClock.findFirst({ where: { id: 1 } }))?.sequence || 0)
      : null;
    const initialChangeCursor = changesSince === null ? contentClockBoundary : null;
    const changeBoundary = changesSince !== null ? contentClockBoundary : null;
    const accountChangeBoundary = accountsSince !== null
      ? contentClockBoundary
      : null;
    const accountChanges = accountsSince !== null
      ? await db.select({
          handle: swarmAccountTombstones.handle,
          did: swarmAccountTombstones.did,
          sequence: swarmAccountTombstones.sequence,
          deletedAt: swarmAccountTombstones.deletedAt,
        }).from(swarmAccountTombstones)
          .where(gt(swarmAccountTombstones.sequence, accountsSince))
          .orderBy(asc(swarmAccountTombstones.sequence))
          .limit(50)
      : [];
    const changeRows = changesSince !== null
      ? await db.select({
          storyId: swarmPostChanges.storyId,
          sequence: swarmPostChanges.sequence,
          changeType: swarmPostChanges.changeType,
          changedAt: swarmPostChanges.changedAt,
        }).from(swarmPostChanges)
          .where(gt(swarmPostChanges.sequence, changesSince))
          .orderBy(asc(swarmPostChanges.sequence))
          .limit(50)
      : [];
    const changedUpsertIds = Array.from(new Set(changeRows
      .filter((change) => change.changeType === 'upsert')
      .map((change) => change.storyId)));

    const indexedPostIds = searchQuery
      ? await searchIndexedPostIds('local', searchQuery)
      : null;
    const searchCondition = indexedPostIds
      ? inArray(posts.id, indexedPostIds)
      : undefined;
    const parsedCursorDate = cursor ? new Date(cursor) : null;
    const cursorDate = parsedCursorDate && !isNaN(parsedCursorDate.getTime())
      ? parsedCursorDate
      : null;
    const parsedSinceDate = since ? new Date(since) : null;
    const sinceDate = parsedSinceDate && !isNaN(parsedSinceDate.getTime())
      ? parsedSinceDate
      : null;
    if (since && !sinceDate) {
      return NextResponse.json({ error: 'Invalid since timestamp' }, { status: 400 });
    }
    const selectedPosts = await db
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
        feedActivityAt: feedStories.latestActivityAt,
      })
      .from(feedStories)
      .innerJoin(posts, eq(posts.id, feedStories.storyId))
      .innerJoin(users, eq(posts.userId, users.id))
      .where(and(
        isNull(posts.replyToId),
        isNull(posts.swarmReplyToId),
        eq(posts.isRemoved, false),
        isNull(users.nodeId),
        eq(users.isSuspended, false),
        notLike(users.handle, '%@%'),
        searchCondition,
        ...(changesSince !== null
          ? [inArray(feedStories.storyId, changedUpsertIds)]
          : []),
        ...(changesSince === null && sinceDate ? [or(
          gt(feedStories.latestActivityAt, sinceDate),
          ...(sinceId ? [and(
            eq(feedStories.latestActivityAt, sinceDate),
            gt(feedStories.storyId, sinceId),
          )] : []),
        )] : []),
        ...(changesSince === null && cursorDate ? [lt(feedStories.latestActivityAt, cursorDate)] : []),
      ))
      .orderBy(...(changesSince === null && sinceDate
        ? [asc(feedStories.latestActivityAt), asc(feedStories.storyId)]
        : [desc(feedStories.latestActivityAt), desc(feedStories.storyId)]))
      .limit(changesSince !== null ? 50 : limit);

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
      ...selectedPosts.map(post => post.id),
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

    const responsePostById = new Map(responsePosts.map((post) => [String(post.id), post as SwarmPost]));
    const changes: SwarmPostChange[] | undefined = changesSince !== null
      ? changeRows.map((change) => {
          const post = responsePostById.get(change.storyId);
          const type = change.changeType === 'upsert' && post ? 'upsert' : 'delete';
          return {
            sequence: change.sequence,
            type,
            postId: change.storyId,
            changedAt: change.changedAt.toISOString(),
            ...(type === 'upsert' ? { post } : {}),
          };
        })
      : undefined;

    // A short page reaches the captured snapshot boundary, including sequence
    // gaps created by other stream types. A full page remains conservative and
    // asks the receiver to request the next page before advancing farther.
    const changeCursor = changesSince === null
      ? initialChangeCursor
      : changeRows.length === 50
        ? changeRows.at(-1)?.sequence ?? changesSince
        : changeBoundary ?? changesSince;
    const hasMoreChanges = changesSince !== null ? changeRows.length === 50 : undefined;
    const publicNodeDomain = getPublicSwarmDomain(nodeDomain);
    const signedChangeBundle = changesSince !== null && publicNodeDomain
      ? await createSignedChangeBundle({
          origin: publicNodeDomain,
          fromCursor: changesSince,
          toCursor: changeCursor ?? changesSince,
          changes: changes || [],
          hasMoreChanges: hasMoreChanges === true,
          nodeIsNsfw,
        })
      : undefined;

    return NextResponse.json({
      posts: changesSince === null ? responsePosts : [],
      changes,
      changeCursor,
      hasMoreChanges,
      signedChangeBundle,
      accountChanges: accountsSince !== null
        ? accountChanges.map((change): SwarmAccountDeletion => ({
            sequence: change.sequence,
            handle: change.handle,
            did: change.did,
            deletedAt: change.deletedAt.toISOString(),
          }))
        : undefined,
      accountChangeCursor: accountsSince !== null
        ? accountChanges.length === 50
          ? accountChanges.at(-1)?.sequence ?? accountsSince
          : accountChangeBoundary
        : undefined,
      hasMoreAccountChanges: accountsSince !== null ? accountChanges.length === 50 : undefined,
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
