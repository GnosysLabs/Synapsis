import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { db, posts, users, media, follows, mutes, blocks, mutedNodes, remoteReposts, userSwarmReposts, notifications, feedStories, remoteFeedStories, collectionPosts, forYouFeedSessions, forYouFeedItems } from '@/db';
import { getSession, requireAuth } from '@/lib/auth';
import { requireSignedAction, SignedActionError, type SignedAction } from '@/lib/auth/verify-signature';
import {
    isCliSignedAction,
    requireCliSignedAction,
    signedActionErrorStatus,
} from '@/lib/auth/cli-credentials';
import { eq, and, asc, desc, gt, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
    findLinkPreviewUrlInText,
    serializeLinkPreviewMedia,
    parseLinkPreviewMediaJson,
} from '@/lib/media/linkPreview';
import { buildVideoLinkPreview, findVideoEmbedUrlInText } from '@/lib/media/video-embed';
import { resolveLinkPreview } from '@/lib/media/resolveLinkPreview';
import { shouldIncludeNsfwFeed } from '@/lib/nsfw/feed-access';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { hasPublishablePostContent } from '@/lib/posts/content-policy';
import { decodeFeedCursor, decodeFeedCursorPosition, encodeFeedCursor } from '@/lib/posts/feed-pagination';
import { mapSwarmPostToPost } from '@/lib/swarm/feed-post';
import { hasStrictLocalUserOrigin } from '@/lib/swarm/local-user-origin';
import { parseBoundedInteger } from '@/lib/http/query';
import {
    FOR_YOU_ALGORITHM,
    FOR_YOU_SESSION_TTL_MS,
    canonicalForYouAuthor,
    emptyForYouDiversityState,
    forYouPostKey,
    parseForYouDiversityState,
    rankForYouFeed,
    type ForYouFeedMeta,
} from '@/lib/posts/for-you-feed';
import { buildForYouViewerSignals } from '@/lib/posts/for-you-signals';
import { registerPostMentions } from '@/lib/mentions/delivery';
import {
    assembleNodeFeedStories,
    collapseSharedFeedPosts,
    setReposterInSummary,
    type NodeFeedReposter,
} from '@/lib/posts/node-feed';
import { mapRemoteReposter } from '@/lib/posts/remote-reposts';
import type { Post } from '@/lib/types';
import {
    getCurrentViewerSensitiveProfileAccess,
    SENSITIVE_PROFILE_MESSAGE,
} from '@/lib/nsfw/remote-profile-access';
import { redactSensitivePostForViewer } from '@/lib/nsfw/content-visibility';
import { safeFederationRequest } from '@/lib/swarm/safe-federation-http';
import { refreshFederatedReplyCounts } from '@/lib/swarm/reply-counts';
import {
    isRemoteNodeBlockResponse,
    NODE_BLOCKED_CODE,
    ORIGIN_UNAVAILABLE_CONTENT,
} from '@/lib/swarm/remote-access-protocol';
import { getBlockedNodeDomains, isNodeBlocked } from '@/lib/swarm/node-blocklist';
import { federationMediaUrlSchema } from '@/lib/utils/federation';
import { normalizeNodeDomain } from '@/lib/swarm/node-domain';
import { getCachedSwarmTimeline } from '@/lib/swarm/content-cache';
import { getViewerSwarmLikedPostIds } from '@/lib/swarm/likes';
import { indexLocalPostContent } from '@/lib/search/post-index';
import {
    canonicalAccountHomeDomain,
    parseAccountAddress,
    requireCanonicalAccountHomeDomain,
    resolveAccountAddress,
} from '@/lib/identity/account-address';
import { canonicalizeMentionsInContent } from '@/lib/mentions/parser';
import {
    attachStoredStuffboxBadgesToPost,
    stuffboxBadgeFromStoredUser,
} from '@/lib/stuffbox/badge';
import { getOrRefreshStuffboxBadge } from '@/lib/stuffbox/badge-status';

const POST_MAX_LENGTH = 600;
const FOR_YOU_CURSOR_PREFIX = 'fy:v1';

function getLocalAccountHomeDomain(): string {
    return requireCanonicalAccountHomeDomain(
        process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
    );
}

type FeedPostWithChildren = {
    id: string;
    createdAt: string | Date;
    repostOf?: FeedPostWithChildren | null;
    replyTo?: FeedPostWithChildren | null;
    isLiked?: boolean;
    isReposted?: boolean;
    nodeDomain?: string | null;
    originalPostId?: string | null;
    feedActivityAt?: string;
    repostsCount?: number;
    repliesCount?: number;
    repostedBy?: Array<{
        id: string;
        handle: string;
        displayName?: string | null;
        avatarUrl?: string | null;
        isNsfw?: boolean;
        nodeDomain?: string | null;
    }>;
    repostedByCount?: number;
};

function encodeForYouCursor(sessionId: string, position: number): string {
    return `${FOR_YOU_CURSOR_PREFIX}:${sessionId}:${position}`;
}

function decodeForYouCursor(cursor: string | null): { sessionId: string; position: number } | null {
    if (!cursor) return null;
    const match = /^fy:v1:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(\d+)$/i.exec(cursor);
    if (!match) return null;
    const position = Number(match[2]);
    return Number.isSafeInteger(position) && position >= 0
        ? { sessionId: match[1], position }
        : null;
}

function parseStoredFeedMeta(value: string): ForYouFeedMeta | null {
    try {
        const parsed = JSON.parse(value) as ForYouFeedMeta;
        return parsed?.algorithm === FOR_YOU_ALGORITHM ? parsed : null;
    } catch {
        return null;
    }
}

function mapUserSwarmRepostToFeedPost(
    row: typeof userSwarmReposts.$inferSelect,
    author: typeof users.$inferSelect,
): FeedPostWithChildren {
    const localNodeDomain = getLocalAccountHomeDomain();
    const remoteAuthorAddress = resolveAccountAddress(row.authorHandle, row.nodeDomain);
    const remoteAuthorHandle = remoteAuthorAddress?.canonical || row.authorHandle;
    const remoteOriginalId = `swarm:${row.nodeDomain}:${row.originalPostId}`;
    const originUnavailable = Boolean(row.originUnavailableAt);

    return {
        id: `swarm-repost:${row.id}`,
        content: '',
        createdAt: row.repostedAt.toISOString(),
        likesCount: 0,
        repostsCount: 0,
        repliesCount: 0,
        author: {
            id: author.id,
            handle: author.handle,
            displayName: author.displayName,
            avatarUrl: author.avatarUrl,
            nodeDomain: localNodeDomain,
            isNsfw: author.isNsfw,
            stuffboxBadge: stuffboxBadgeFromStoredUser(author),
        },
        repostOfId: remoteOriginalId,
        repostOf: {
            id: remoteOriginalId,
            originalPostId: row.originalPostId,
            content: originUnavailable ? ORIGIN_UNAVAILABLE_CONTENT : row.content,
            createdAt: row.postCreatedAt.toISOString(),
            likesCount: row.likesCount,
            repostsCount: row.repostsCount,
            repliesCount: row.repliesCount,
            isSwarm: true,
            originUnavailable,
            nodeDomain: row.nodeDomain,
            // Legacy cached repost snapshots predate sensitivity columns.
            // Leave classifiers unknown so the shared renderer fails closed.
            isNsfw: originUnavailable ? false : undefined,
            nodeIsNsfw: originUnavailable ? false : undefined,
            author: {
                id: `swarm:${row.nodeDomain}:${remoteAuthorAddress?.username || row.authorHandle}`,
                handle: remoteAuthorHandle,
                displayName: row.authorDisplayName || row.authorHandle,
                avatarUrl: row.authorAvatarUrl,
                isRemote: true,
                nodeDomain: row.nodeDomain,
                isNsfw: originUnavailable ? false : undefined,
                nodeIsNsfw: originUnavailable ? false : undefined,
            },
            media: originUnavailable ? [] : row.mediaJson ? JSON.parse(row.mediaJson) : [],
            linkPreviewUrl: originUnavailable ? null : row.linkPreviewUrl,
            linkPreviewTitle: originUnavailable ? null : row.linkPreviewTitle,
            linkPreviewDescription: originUnavailable ? null : row.linkPreviewDescription,
            linkPreviewImage: originUnavailable ? null : row.linkPreviewImage,
            linkPreviewType: originUnavailable ? null : row.linkPreviewType,
            linkPreviewVideoUrl: originUnavailable ? null : row.linkPreviewVideoUrl,
            linkPreviewMedia: originUnavailable ? null : parseLinkPreviewMediaJson(row.linkPreviewMediaJson) || null,
        },
    } as unknown as FeedPostWithChildren;
}

async function getMixedFeedCursorDate(cursor: string | null) {
    if (!cursor) {
        return null;
    }

    const timestampCursor = decodeFeedCursor(cursor);
    if (timestampCursor) {
        return timestampCursor;
    }

    if (cursor.startsWith('swarm-repost:')) {
        const repostRow = await db.query.userSwarmReposts.findFirst({
            where: { id: cursor.replace('swarm-repost:', '') },
        });
        return repostRow?.repostedAt ?? null;
    }

    const cursorPost = await db.query.posts.findFirst({
        where: { id: cursor },
    });
    return cursorPost?.createdAt ?? null;
}

function collectNestedPosts(posts: FeedPostWithChildren[]): FeedPostWithChildren[] {
    const collected: FeedPostWithChildren[] = [];
    const seen = new Set<string>();

    const visit = (post: FeedPostWithChildren | null | undefined) => {
        if (!post || seen.has(post.id)) return;
        seen.add(post.id);
        collected.push(post);
        visit(post.repostOf);
        visit(post.replyTo);
    };

    posts.forEach(visit);
    return collected;
}

function applyInteractionFlags(
    posts: FeedPostWithChildren[],
    likedIds: Set<string>,
    repostedIds: Set<string>,
    viewerReposter: NodeFeedReposter,
): FeedPostWithChildren[] {
    return posts.map((post) => {
        const isReposted = repostedIds.has(post.id);
        const viewerSummary = isReposted
            ? setReposterInSummary(
                post.repostedBy,
                Math.max(post.repostedByCount || 0, post.repostsCount || 0),
                viewerReposter,
                true,
            )
            : null;

        return {
            ...post,
            ...viewerSummary,
            isLiked: likedIds.has(post.id),
            isReposted,
            repostOf: post.repostOf
                ? applyInteractionFlags([post.repostOf], likedIds, repostedIds, viewerReposter)[0]
                : post.repostOf,
            replyTo: post.replyTo
                ? applyInteractionFlags([post.replyTo], likedIds, repostedIds, viewerReposter)[0]
                : post.replyTo,
        };
    });
}

const embeddedPostRelations = {
    author: true,
    media: true,
    replyTo: {
        with: {
            author: true,
            media: true,
        },
    },
} as const;

const feedPostRelations = {
    ...embeddedPostRelations,
    repostOf: {
        with: embeddedPostRelations,
    },
} as const;

async function getLocalNodeFeed(cursor: string | null, limit: number | null): Promise<FeedPostWithChildren[]> {
    const localNodeDomain = getLocalAccountHomeDomain();
    const cursorPosition = decodeFeedCursorPosition(cursor);
    const cursorCondition = cursorPosition
        ? or(
            lt(feedStories.latestActivityAt, cursorPosition.at),
            ...(cursorPosition.id ? [and(
                eq(feedStories.latestActivityAt, cursorPosition.at),
                lt(feedStories.storyId, cursorPosition.id),
            )] : []),
        )
        : undefined;
    const activityQuery = db.select({
        storyId: feedStories.storyId,
        latestActivityAt: feedStories.latestActivityAt,
    }).from(feedStories)
        .innerJoin(posts, eq(posts.id, feedStories.storyId))
        .innerJoin(users, eq(users.id, posts.userId))
        .where(and(
            eq(posts.isRemoved, false),
            isNull(posts.replyToId),
            isNull(posts.swarmReplyToId),
            eq(users.isLocalAccount, true),
            cursorCondition,
        ))
        .orderBy(desc(feedStories.latestActivityAt), desc(feedStories.storyId));
    const activityRows = limit === null
        ? await activityQuery
        : await activityQuery.limit(limit);
    const storyIds = activityRows.map((row) => row.storyId);

    if (storyIds.length === 0) {
        return [];
    }

    const [originalPosts, unfilteredRepostRows, remoteRepostRows] = await Promise.all([
        db.query.posts.findMany({
            where: { AND: [{ id: { in: storyIds } }, { isRemoved: false }] },
            with: feedPostRelations,
        }),
        db.query.posts.findMany({
            where: { AND: [{ repostOfId: { in: storyIds } }, { isRemoved: false }] },
            with: { author: true },
            orderBy: (posts, { desc }) => [desc(posts.createdAt)],
        }),
        db.query.remoteReposts.findMany({
            where: { postId: { in: storyIds } },
            orderBy: (remoteReposts, { desc }) => [desc(remoteReposts.createdAt)],
        }),
    ]);
    const repostRows = unfilteredRepostRows.filter((row) =>
        hasStrictLocalUserOrigin(row.author));

    const federatedRepostRows = remoteRepostRows.map((row) => {
        const reposter = mapRemoteReposter(row);
        return {
            repostOfId: row.postId,
            author: {
                id: reposter.id,
                handle: reposter.handle,
                displayName: reposter.displayName,
                avatarUrl: reposter.avatarUrl || null,
                isNsfw: reposter.isNsfw || false,
                nodeDomain: reposter.nodeDomain,
            },
        };
    });

    return assembleNodeFeedStories(
        activityRows,
        originalPosts,
        [...repostRows, ...federatedRepostRows],
        localNodeDomain,
    ) as FeedPostWithChildren[];
}

async function getLocallyRepostedRemoteStories(
    cursor: string | null,
    limit: number | null,
): Promise<FeedPostWithChildren[]> {
    const cursorPosition = decodeFeedCursorPosition(cursor);
    const localDomain = getLocalAccountHomeDomain();
    const remoteStoryFeedId = sql<string>`'swarm:' || ${remoteFeedStories.nodeDomain} || ':' || ${remoteFeedStories.originalPostId}`;
    const cursorCondition = cursorPosition
        ? or(
            lt(remoteFeedStories.latestActivityAt, cursorPosition.at),
            ...(cursorPosition.id ? [and(
                eq(remoteFeedStories.latestActivityAt, cursorPosition.at),
                lt(remoteStoryFeedId, cursorPosition.id),
            )] : []),
        )
        : undefined;
    const activityQuery = db.select({
        nodeDomain: remoteFeedStories.nodeDomain,
        originalPostId: remoteFeedStories.originalPostId,
        latestActivityAt: remoteFeedStories.latestActivityAt,
    }).from(remoteFeedStories)
        .where(and(
            ne(remoteFeedStories.nodeDomain, localDomain),
            cursorCondition,
        ))
        .orderBy(
            desc(remoteFeedStories.latestActivityAt),
            desc(remoteFeedStories.nodeDomain),
            desc(remoteFeedStories.originalPostId),
        );
    const activityRows = limit === null
        ? await activityQuery
        : await activityQuery.limit(limit);

    if (activityRows.length === 0) return [];

    const selectedKeys = new Set(activityRows.map((row) => `${row.nodeDomain}:${row.originalPostId}`));
    const snapshotRows = (await db.query.userSwarmReposts.findMany({
        where: {
            AND: [
                { nodeDomain: { in: Array.from(new Set(activityRows.map((row) => row.nodeDomain))) } },
                { originalPostId: { in: Array.from(new Set(activityRows.map((row) => row.originalPostId))) } },
            ],
        },
        orderBy: (userSwarmReposts, { desc }) => [desc(userSwarmReposts.repostedAt)],
    })).filter((row) => selectedKeys.has(`${row.nodeDomain}:${row.originalPostId}`));
    const reposterIds = Array.from(new Set(snapshotRows.map((row) => row.userId)));
    const reposters = reposterIds.length > 0
        ? await db.query.users.findMany({ where: { id: { in: reposterIds } } })
        : [];
    const repostersById = new Map(reposters.map((user) => [user.id, user]));
    const wrappers = snapshotRows.flatMap((row) => {
        const reposter = repostersById.get(row.userId);
        return reposter ? [mapUserSwarmRepostToFeedPost(row, reposter)] : [];
    });

    const stories = collapseSharedFeedPosts(
        wrappers as unknown as Post[],
        localDomain,
    ) as FeedPostWithChildren[];
    return refreshFederatedReplyCounts(stories);
}

const createPostSchema = z.object({
    clientPostId: z.string().uuid().optional(),
    content: z.string().max(POST_MAX_LENGTH),
    replyToId: z.string().uuid().optional(), // Must be UUID (swarm replies use separate field)
    swarmReplyTo: z.object({
        postId: z.string(),
        nodeDomain: z.string(),
        content: z.string().optional(),
        author: z.object({
            handle: z.string(),
            displayName: z.string().optional().nullable(),
            avatarUrl: z.string().optional().nullable(),
            nodeDomain: z.string().optional().nullable(),
        }).optional(),
    }).optional(),
    mediaIds: z.array(z.string().uuid()).max(4).optional(),
    collectionIds: z.array(z.string().uuid()).max(200).optional().default([]),
    mediaManifest: z.array(z.strictObject({
        id: z.string().uuid(),
        url: federationMediaUrlSchema,
        altText: z.string().max(2_000).nullish(),
        mimeType: z.string().max(255).nullish(),
    })).max(4).optional(),
    isNsfw: z.boolean().optional(),
    linkPreview: z.object({
        url: z.string().url(),
        title: z.string().optional(),
        description: z.string().optional(),
        image: z.string().url().optional().nullable(),
        type: z.enum(['card', 'image', 'gallery', 'video']).optional().nullable(),
        videoUrl: z.string().url().optional().nullable(),
        media: z.array(z.object({
            url: z.string().url(),
            width: z.number().optional().nullable(),
            height: z.number().optional().nullable(),
            mimeType: z.string().optional().nullable(),
        })).optional().nullable(),
    }).optional().nullable(),
}).superRefine((post, context) => {
    if (!hasPublishablePostContent(post.content, post.mediaIds)) {
        context.addIssue({
            code: 'custom',
            path: ['content'],
            message: 'Add text or attach media before posting',
        });
    }
});

function isSignedActionPayload(payload: unknown): payload is SignedAction {
    if (!payload || typeof payload !== 'object') return false;
    const value = payload as Record<string, unknown>;
    return typeof value.action === 'string'
        && typeof value.did === 'string'
        && typeof value.handle === 'string'
        && typeof value.ts === 'number'
        && typeof value.nonce === 'string'
        && typeof value.sig === 'string'
        && typeof value.data === 'object'
        && value.data !== null;
}

// Create a new post
export async function POST(request: Request) {
    try {
        const requestBody = await request.json();
        const cliAuthorization = isCliSignedAction(requestBody)
            ? await requireCliSignedAction(requestBody, 'post', 'posts:write')
            : null;
        const user = cliAuthorization?.user ?? (isSignedActionPayload(requestBody)
            ? await requireSignedAction(requestBody, 'post')
            : await requireAuth());
        const stuffboxBadge = await getOrRefreshStuffboxBadge(user);
        const data = createPostSchema.parse(
            isCliSignedAction(requestBody) || isSignedActionPayload(requestBody)
                ? requestBody.data
                : requestBody
        );
        const nodeDomain = getLocalAccountHomeDomain();

        if (canonicalizeMentionsInContent(data.content, nodeDomain) !== data.content) {
            return NextResponse.json(
                { error: 'Mentions must use canonical @handle@node addresses' },
                { status: 400 },
            );
        }

        if (user.isSuspended || user.isSilenced) {
            return NextResponse.json({ error: 'Account restricted' }, { status: 403 });
        }
        if (isSignedActionPayload(requestBody) && !data.clientPostId) {
            return NextResponse.json(
                { error: 'Signed posts require a client-generated post ID' },
                { status: 400 },
            );
        }

        if (
            data.swarmReplyTo
            && await (await import('@/lib/swarm/remote-access'))
                .isRemoteNodeAccessDenied(data.swarmReplyTo.nodeDomain)
        ) {
            return NextResponse.json({
                error: 'This origin has blocked federation access from this node.',
                code: NODE_BLOCKED_CODE,
            }, { status: 403 });
        }
        if (data.swarmReplyTo && !isSignedActionPayload(requestBody)) {
            return NextResponse.json(
                { error: 'Federated replies require a browser-signed user action' },
                { status: 428 },
            );
        }

        const swarmReplyOriginDomain = data.swarmReplyTo
            ? canonicalAccountHomeDomain(data.swarmReplyTo.nodeDomain)
            : null;
        if (
            data.swarmReplyTo
            && (
                !swarmReplyOriginDomain
                || swarmReplyOriginDomain !== data.swarmReplyTo.nodeDomain
            )
        ) {
            return NextResponse.json(
                { error: 'Federated reply node domain must be canonical' },
                { status: 400 },
            );
        }
        if (swarmReplyOriginDomain && await isNodeBlocked(swarmReplyOriginDomain)) {
            return NextResponse.json({
                error: 'This node is blocked by the local administrator.',
                code: 'NODE_BLOCKED_LOCALLY',
            }, { status: 403 });
        }

        if (data.swarmReplyTo?.author) {
            const authorAddress = parseAccountAddress(data.swarmReplyTo.author.handle);
            const rawAuthorDomain = data.swarmReplyTo.author.nodeDomain ?? swarmReplyOriginDomain;
            const authorDomain = canonicalAccountHomeDomain(rawAuthorDomain);
            if (
                !authorAddress
                || authorAddress.canonical !== data.swarmReplyTo.author.handle
                || !rawAuthorDomain
                || authorDomain !== rawAuthorDomain
                || authorDomain !== authorAddress.homeDomain
                || authorDomain !== swarmReplyOriginDomain
            ) {
                return NextResponse.json(
                    { error: 'Federated reply author must use a matching canonical handle and node domain' },
                    { status: 400 },
                );
            }
        }

        // Build swarm reply fields if replying to a swarm post
        const swarmReplyFields = data.swarmReplyTo ? {
            swarmReplyToId: `swarm:${swarmReplyOriginDomain}:${data.swarmReplyTo.postId}`,
            swarmReplyToContent: data.swarmReplyTo.content?.slice(0, 300) || null,
            swarmReplyToAuthor: data.swarmReplyTo.author ? JSON.stringify({
                handle: data.swarmReplyTo.author.handle,
                displayName: data.swarmReplyTo.author.displayName,
                avatarUrl: data.swarmReplyTo.author.avatarUrl,
                nodeDomain: swarmReplyOriginDomain,
            }) : null,
        } : {};

        const requestedMediaIds = [...new Set(data.mediaIds || [])];
        let unattachedMedia: typeof media.$inferSelect[] = [];
        if (requestedMediaIds.length > 0) {
            unattachedMedia = await db.query.media.findMany({
                where: { AND: [{ id: { in: requestedMediaIds } }, { userId: user.id }, { postId: { isNull: true } }] },
            });
        }

        if (unattachedMedia.length !== requestedMediaIds.length) {
            return NextResponse.json(
                { error: 'One or more media attachments are unavailable. Please upload them again.' },
                { status: 400 },
            );
        }
        if (isSignedActionPayload(requestBody)) {
            const manifest = data.mediaManifest || [];
            const manifestById = new Map(manifest.map((item) => [item.id, item]));
            const mediaProofMatches = manifest.length === requestedMediaIds.length
                && manifestById.size === manifest.length
                && unattachedMedia.every((item) => {
                    const signed = manifestById.get(item.id);
                    return Boolean(signed
                        && signed.url === item.url
                        && (signed.mimeType || null) === (item.mimeType || null)
                        && (signed.altText || null) === (item.altText || null));
                });
            if (!mediaProofMatches) {
                return NextResponse.json(
                    { error: 'Media authorization no longer matches the uploaded assets' },
                    { status: 409 },
                );
            }
        }

        const postContent = data.content.trim();
        if (!hasPublishablePostContent(postContent, unattachedMedia.map(item => item.id))) {
            return NextResponse.json(
                { error: 'Add text or attach media before posting.' },
                { status: 400 },
            );
        }
        const submittedVideoPreview = data.linkPreview?.url
            ? buildVideoLinkPreview(data.linkPreview.url)
            : null;
        const contentVideoUrl = findVideoEmbedUrlInText(postContent);
        const contentVideoPreview = contentVideoUrl
            ? buildVideoLinkPreview(contentVideoUrl)
            : null;
        const contentLinkUrl = findLinkPreviewUrlInText(postContent);
        const resolvedContentPreview = data.linkPreview === undefined
            && contentLinkUrl
            && !contentVideoPreview
            ? await resolveLinkPreview(contentLinkUrl)
            : null;
        const persistedLinkPreview = submittedVideoPreview
            || contentVideoPreview
            || (data.linkPreview === null ? null : data.linkPreview || resolvedContentPreview);

        const selectedCollectionIds = [...new Set(data.collectionIds)];
        if (selectedCollectionIds.length > 0) {
            const ownedCollections = await db.query.collections.findMany({
                where: {
                    AND: [
                        { id: { in: selectedCollectionIds } },
                        { userId: user.id },
                    ],
                },
                columns: { id: true },
                limit: 200,
            });
            if (ownedCollections.length !== selectedCollectionIds.length) {
                return NextResponse.json(
                    { error: 'A selected collection is not available' },
                    { status: 400 },
                );
            }
        }

        const post = await db.transaction(async (tx) => {
            const [createdPost] = await tx.insert(posts).values({
                id: data.clientPostId,
                userId: user.id,
                content: postContent,
                replyToId: data.replyToId,
                ...swarmReplyFields,
                isNsfw: data.isNsfw || user.isNsfw || false, // Inherit from account if account is NSFW
                apId: `https://${nodeDomain}/posts/${data.clientPostId || crypto.randomUUID()}`,
                apUrl: `https://${nodeDomain}/posts/${data.clientPostId || crypto.randomUUID()}`,
                linkPreviewUrl: persistedLinkPreview?.url,
                linkPreviewTitle: persistedLinkPreview?.title,
                linkPreviewDescription: persistedLinkPreview?.description,
                linkPreviewImage: persistedLinkPreview?.image,
                linkPreviewType: persistedLinkPreview?.type,
                linkPreviewVideoUrl: persistedLinkPreview?.videoUrl,
                linkPreviewMediaJson: serializeLinkPreviewMedia(persistedLinkPreview?.media),
            }).returning();
            if (selectedCollectionIds.length > 0) {
                await tx.insert(collectionPosts).values(selectedCollectionIds.map((collectionId) => ({
                    collectionId,
                    postId: createdPost.id,
                })));
            }
            return createdPost;
        });
        await indexLocalPostContent(post.id, post.content).catch((error) => {
            console.error('[Search] Failed to index new post:', error);
        });

        try {
            if (data.swarmReplyTo) {
                const nodeIsNsfw = await requireLocalNodeNsfwClassification();
                const protocol = data.swarmReplyTo.nodeDomain.includes('localhost') ? 'http' : 'https';
                const targetUrl = `${protocol}://${data.swarmReplyTo.nodeDomain}/api/swarm/replies`;

                const replyPayload = {
                    federation: (await import('@/lib/swarm/federated-action'))
                        .createFederationActionContext({
                            destinationDomain: data.swarmReplyTo.nodeDomain,
                            method: 'POST',
                            path: '/api/swarm/replies',
                        }),
                    userAction: requestBody,
                    postId: data.swarmReplyTo.postId,
                    reply: {
                        id: post.id,
                        content: post.content,
                        createdAt: post.createdAt.toISOString(),
                        author: {
                            handle: user.handle,
                            displayName: user.displayName || user.handle,
                            avatarUrl: user.avatarUrl || undefined,
                            did: user.did,
                            publicKey: user.publicKey,
                            isNsfw: user.isNsfw,
                            stuffboxBadge,
                        },
                        nodeDomain,
                        nodeIsNsfw,
                        isNsfw: post.isNsfw,
                        mediaUrls: (data.mediaManifest || []).map((item) => item.url),
                    },
                };

                const { createSignedPayload } = await import('@/lib/swarm/signature');
                const { payload, signature } = await createSignedPayload(replyPayload);

                const response = await safeFederationRequest(targetUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Swarm-Source-Domain': nodeDomain,
                        'X-Swarm-Signature': signature,
                    },
                    body: JSON.stringify(payload),
                    timeoutMs: 8_000,
                    maxResponseBytes: 64 * 1024,
                });

                if (response.status < 200 || response.status >= 300) {
                    if (isRemoteNodeBlockResponse(response)) {
                        await (await import('@/lib/swarm/remote-access'))
                            .markRemoteNodeAccessDenied(data.swarmReplyTo.nodeDomain);
                        await db.delete(posts).where(eq(posts.id, post.id));
                        return NextResponse.json({
                            error: 'This origin has blocked federation access from this node.',
                            code: NODE_BLOCKED_CODE,
                        }, { status: 403 });
                    }
                    const body = response.text();
                    throw new Error(body || `Remote node rejected reply (${response.status})`);
                }
                await (await import('@/lib/swarm/remote-access'))
                    .clearRemoteNodeAccessDenied(data.swarmReplyTo.nodeDomain);
            }

            if (requestedMediaIds.length > 0) {
                await db.update(media)
                    .set({ postId: post.id })
                    .where(and(
                        inArray(media.id, requestedMediaIds),
                        eq(media.userId, user.id),
                        isNull(media.postId),
                    ));
            }

            // Update user's post count (atomic increment to prevent race conditions)
            await db.update(users)
                .set({ postsCount: sql`${users.postsCount} + 1` })
                .where(eq(users.id, user.id));

            // If this is a reply, update the parent's reply count (atomic increment)
            if (data.replyToId) {
                await db.update(posts)
                    .set({ repliesCount: sql`${posts.repliesCount} + 1` })
                    .where(eq(posts.id, data.replyToId));
            }
        } catch (err) {
            await db.delete(posts).where(eq(posts.id, post.id));
            console.error('[Swarm] Error creating synchronized reply:', err);
            return NextResponse.json(
                { error: err instanceof Error ? err.message : 'Failed to deliver reply to origin node' },
                { status: 502 }
            );
        }

        let attachedMedia: typeof media.$inferSelect[] = [];
        if (requestedMediaIds.length > 0) {
            attachedMedia = await db.query.media.findMany({
                where: { AND: [{ id: { in: requestedMediaIds } }, { userId: user.id }, { postId: post.id }] },
            });
        }

        if (data.replyToId) {
            try {
                const parentPost = await db.query.posts.findFirst({
                    where: { id: data.replyToId },
                    with: {
                        author: true,
                    },
                });

                if (parentPost && parentPost.userId !== user.id) {
                    await db.insert(notifications).values({
                        userId: parentPost.userId,
                        actorId: user.id,
                        actorHandle: user.handle,
                        actorDisplayName: user.displayName,
                        actorAvatarUrl: user.avatarUrl,
                        actorNodeDomain: user.homeDomain,
                        postId: parentPost.id,
                        postContent: post.content?.slice(0, 200) || null,
                        type: 'reply',
                    });
                }
            } catch (err) {
                console.error('[Posts] Error creating reply notifications:', err);
                console.error('[Posts] Context:', { postId: post.id, replyToId: data.replyToId, userId: user.id });
            }
        }

        // Resolve local mentions and durably enqueue federated delivery before
        // returning. Remote network I/O is retried from the persistent outbox.
        try {
            await registerPostMentions({
                postId: post.id,
                content: postContent,
                actor: {
                    id: user.id,
                    handle: user.handle,
                    displayName: user.displayName,
                    avatarUrl: user.avatarUrl,
                    did: user.did,
                    publicKey: user.publicKey,
                },
                nodeDomain,
                userAction: isSignedActionPayload(requestBody) ? requestBody : undefined,
            });
        } catch (err) {
            console.error('[Posts] Error registering mentions:', err);
            console.error('[Posts] Context:', { postId: post.id, userId: user.id, content: postContent.slice(0, 100) });
        }

        // Swarm post federation is pull-based. Do not fan new posts out to the
        // retired /api/swarm/inbox endpoint on every active node.
        return NextResponse.json({ success: true, post: { ...post, media: attachedMedia } });
    } catch (error) {
        console.error('Create post error:', error);

        if (error instanceof z.ZodError) {
            return NextResponse.json(
                { error: 'Invalid input', details: error.issues },
                { status: 400 }
            );
        }

        if (error instanceof SignedActionError) {
            return NextResponse.json(
                { error: 'Signed action rejected', code: error.code },
                { status: signedActionErrorStatus(error) },
            );
        }

        if (error instanceof Error) {
            // Handle signature verification errors
            if (error.message === 'Invalid signature' ||
                error.message === 'User not found' ||
                error.message === 'Handle mismatch' ||
                error.message === 'Timestamp too old or in future') {
                return NextResponse.json(
                    { error: error.message, code: 'INVALID_SIGNATURE' },
                    { status: 403 }
                );
            }

            if (error.message === 'Authentication required') {
                return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
            }
        }

        return NextResponse.json(
            { error: 'Failed to create post' },
            { status: 500 }
        );
    }
}

// Get timeline / feed
export async function GET(request: Request) {
    try {
        // Return empty posts if no database is connected (for UI testing)
        if (!db) {
            return NextResponse.json({ posts: [], nextCursor: null });
        }

        const { searchParams } = new URL(request.url);
        const type = searchParams.get('type') || 'home'; // home, public, user, curated, replies
        const userId = searchParams.get('userId');
        const cursor = searchParams.get('cursor');
        const limit = parseBoundedInteger(searchParams.get('limit'), {
            defaultValue: 20,
            min: 1,
            max: 50,
        });
        const localNodeIsNsfw = await requireLocalNodeNsfwClassification();
        const requestSession = await getSession().catch(() => null);

        // Every feed alias is content-bearing. Adult-only nodes must not be
        // anonymously browsable by switching the `type` query parameter.
        if (localNodeIsNsfw && !requestSession?.user) {
            return NextResponse.json({
                error: 'Sign in to this node to view its adult content feed',
                code: 'LOCAL_AUTH_REQUIRED',
            }, { status: 401 });
        }
        const excludedRemoteDomains = new Set(await getBlockedNodeDomains());
        if (requestSession?.user) {
            const viewerMutedNodes = await db.select({ nodeDomain: mutedNodes.nodeDomain })
                .from(mutedNodes)
                .where(eq(mutedNodes.userId, requestSession.user.id));
            viewerMutedNodes.forEach((row) => excludedRemoteDomains.add(normalizeNodeDomain(row.nodeDomain)));
        }

        let feedPosts: FeedPostWithChildren[] = [];
        let explicitNextCursor: string | null | undefined;
        let forYouResponseMeta: Record<string, unknown> | undefined;
        // Base filter excludes removed posts and replies (replies only show on detail/profile)
        const baseFilter = {
            isRemoved: false,
            replyToId: { isNull: true as const },
            swarmReplyToId: { isNull: true as const },
        };
        // Filter for replies only
        const repliesFilter = {
            isRemoved: false,
            OR: [
                { replyToId: { isNotNull: true as const } },
                { swarmReplyToId: { isNotNull: true as const } },
            ],
        };

        if ((type === 'user' || type === 'replies') && userId) {
            const targetUser = await db.query.users.findFirst({ where: { id: userId } });
            if (!targetUser || targetUser.isSuspended) {
                return NextResponse.json({ error: 'User not found' }, { status: 404 });
            }
            const profileAccess = await getCurrentViewerSensitiveProfileAccess({
                accountIsNsfw: targetUser.isNsfw,
            });
            if (!profileAccess.allowed) {
                return NextResponse.json(
                    { posts: [], nextCursor: null, restricted: true, error: SENSITIVE_PROFILE_MESSAGE },
                    { status: 403 },
                );
            }
        }

        if (type === 'local') {
            // One card per original local post, resurfaced by its latest repost.
            const [localStories, remoteStories] = await Promise.all([
                getLocalNodeFeed(cursor, limit),
                getLocallyRepostedRemoteStories(cursor, limit),
            ]);
            feedPosts = collapseSharedFeedPosts([
                ...localStories,
                ...remoteStories,
            ] as unknown as Post[], getLocalAccountHomeDomain())
                .slice(0, limit) as FeedPostWithChildren[];
        } else if (type === 'public') {
            // Public timeline - all local posts + all cached remote posts
            const localPosts = await db.query.posts.findMany({
                where: baseFilter,
                with: feedPostRelations,
                orderBy: (posts, { desc }) => [desc(posts.createdAt)],
                limit: limit * 2,
            });

            const remoteTimeline = await getCachedSwarmTimeline({
                limit: Math.min(limit * 4, 200),
                includeNsfw: true,
                excludeDomains: excludedRemoteDomains,
            });
            const transformedRemote = remoteTimeline.posts.map((post) =>
                mapSwarmPostToPost(post, {
                    localDomain: getLocalAccountHomeDomain(),
                }));

            // Merge and sort by date
            feedPosts = [...localPosts, ...transformedRemote]
                .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                .slice(0, limit);
        } else if (type === 'user' && userId) {
            // User's posts (excluding replies)
            let whereCondition = {
                ...baseFilter,
                userId,
                createdAt: undefined as { lt: Date } | undefined,
            };

            // Apply cursor-based pagination
            if (cursor) {
                const cursorPost = await db.query.posts.findFirst({
                    where: { id: cursor },
                });
                if (cursorPost) {
                    whereCondition = { ...baseFilter, userId, createdAt: { lt: cursorPost.createdAt } };
                }
            }

            feedPosts = await db.query.posts.findMany({
                where: whereCondition,
                with: feedPostRelations,
                orderBy: (posts, { desc }) => [desc(posts.createdAt)],
                limit,
            });
        } else if (type === 'replies' && userId) {
            // User's replies only
            let whereCondition = {
                ...repliesFilter,
                userId,
                createdAt: undefined as { lt: Date } | undefined,
            };

            // Apply cursor-based pagination
            if (cursor) {
                const cursorPost = await db.query.posts.findFirst({
                    where: { id: cursor },
                });
                if (cursorPost) {
                    whereCondition = { ...repliesFilter, userId, createdAt: { lt: cursorPost.createdAt } };
                }
            }

            feedPosts = await db.query.posts.findMany({
                where: whereCondition,
                with: feedPostRelations,
                orderBy: (posts, { desc }) => [desc(posts.createdAt)],
                limit,
            });
        } else if (type === 'for-you' || type === 'curated') {
            // For You ranks the complete eligible local + cached network corpus.
            // A short-lived server session remembers only served items and
            // diversity state, giving infinite scroll a stable snapshot without
            // imposing a global candidate-window cap.
            const viewer = requestSession?.user;
            if (!viewer) {
                return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
            }
            const includeNsfw = shouldIncludeNsfwFeed({
                viewer,
                localNodeIsNsfw,
            });
            const localDomain = getLocalAccountHomeDomain();
            const now = new Date();
            await db.delete(forYouFeedSessions).where(lt(forYouFeedSessions.expiresAt, now));

            const decodedCursor = decodeForYouCursor(cursor);
            if (cursor && !decodedCursor) {
                return NextResponse.json({ error: 'Invalid For You cursor' }, { status: 400 });
            }

            let session: typeof forYouFeedSessions.$inferSelect;
            let requestedPosition = decodedCursor?.position ?? 0;
            if (decodedCursor) {
                const [existingSession] = await db.select().from(forYouFeedSessions).where(and(
                    eq(forYouFeedSessions.id, decodedCursor.sessionId),
                    eq(forYouFeedSessions.userId, viewer.id),
                    gt(forYouFeedSessions.expiresAt, now),
                )).limit(1);
                if (!existingSession) {
                    return NextResponse.json({ error: 'For You cursor expired', restart: true }, { status: 410 });
                }
                if (requestedPosition > existingSession.nextPosition) {
                    return NextResponse.json({ error: 'Invalid For You cursor position' }, { status: 400 });
                }
                session = existingSession;
            } else {
                const snapshotAt = now;
                session = {
                    id: randomUUID(),
                    userId: viewer.id,
                    snapshotAt,
                    nextPosition: 0,
                    diversityStateJson: JSON.stringify(emptyForYouDiversityState()),
                    exhausted: false,
                    expiresAt: new Date(snapshotAt.getTime() + FOR_YOU_SESSION_TTL_MS),
                    createdAt: now,
                    updatedAt: now,
                };
                await db.insert(forYouFeedSessions).values(session);
                requestedPosition = 0;
            }

            const [localStories, locallyRepostedRemoteStories, swarmResult, muteRows, blockRows] = await Promise.all([
                getLocalNodeFeed(null, null),
                getLocallyRepostedRemoteStories(null, null),
                getCachedSwarmTimeline({
                    complete: true,
                    includeNsfw,
                    excludeDomains: excludedRemoteDomains,
                }),
                db.select({ mutedUserId: mutes.mutedUserId })
                    .from(mutes)
                    .where(eq(mutes.userId, viewer.id)),
                db.select({ userId: blocks.userId, blockedUserId: blocks.blockedUserId })
                    .from(blocks)
                    .where(or(eq(blocks.userId, viewer.id), eq(blocks.blockedUserId, viewer.id))),
            ]);
            const mutedIds = new Set(muteRows.map((row) => row.mutedUserId));
            const blockedIds = new Set(blockRows.map((row) => (
                row.userId === viewer.id ? row.blockedUserId : row.userId
            )));
            const excludedUserIds = Array.from(new Set([...mutedIds, ...blockedIds]));
            const excludedUsers = excludedUserIds.length > 0
                ? await db.select({ id: users.id, handle: users.handle, homeDomain: users.homeDomain })
                    .from(users)
                    .where(inArray(users.id, excludedUserIds))
                : [];
            const excludedHandles = new Set(excludedUsers.map((account) => (
                canonicalForYouAuthor(account.handle, account.homeDomain)
            )));
            const swarmPosts = swarmResult.posts.map((post) => mapSwarmPostToPost(post, { localDomain }));
            const eligiblePosts = collapseSharedFeedPosts([
                ...localStories as unknown as Post[],
                ...swarmPosts,
                ...locallyRepostedRemoteStories as unknown as Post[],
            ], localDomain)
                .flatMap((post) => {
                    const createdAt = new Date(post.createdAt).getTime();
                    const activityAt = new Date(post.feedActivityAt || post.createdAt).getTime();
                    if (!Number.isFinite(createdAt)
                        || createdAt > session.snapshotAt.getTime()
                        || (!includeNsfw && Boolean(
                            post.isNsfw
                            || post.author.isNsfw
                            || post.nodeIsNsfw
                            || post.author.nodeIsNsfw
                        ))
                        || mutedIds.has(post.author.id)
                        || blockedIds.has(post.author.id)
                        || excludedHandles.has(canonicalForYouAuthor(
                            post.author.handle,
                            post.nodeDomain || post.author.nodeDomain || localDomain,
                        ))) {
                        return [];
                    }
                    // A repost that happens after this session began must not
                    // make an older story disappear or jump forward mid-scroll.
                    return [{
                        ...post,
                        feedActivityAt: Number.isFinite(activityAt)
                            && activityAt <= session.snapshotAt.getTime()
                            ? post.feedActivityAt
                            : post.createdAt,
                    }];
                });
            const candidateByKey = new Map(eligiblePosts.map((post) => [forYouPostKey(post), post]));

            if (requestedPosition < session.nextPosition) {
                const storedItems = await db.select().from(forYouFeedItems).where(and(
                    eq(forYouFeedItems.sessionId, session.id),
                    gte(forYouFeedItems.position, requestedPosition),
                    lt(forYouFeedItems.position, requestedPosition + limit),
                )).orderBy(asc(forYouFeedItems.position));
                feedPosts = storedItems.flatMap((item) => {
                    const post = candidateByKey.get(item.postKey);
                    const feedMeta = parseStoredFeedMeta(item.feedMetaJson);
                    return post && feedMeta ? [{ ...post, feedMeta }] : [];
                });
                const nextPosition = Math.min(requestedPosition + limit, session.nextPosition);
                explicitNextCursor = nextPosition < session.nextPosition || !session.exhausted
                    ? encodeForYouCursor(session.id, nextPosition)
                    : null;
                forYouResponseMeta = {
                    algorithm: FOR_YOU_ALGORITHM,
                    candidateCount: eligiblePosts.length,
                    sessionExpiresAt: session.expiresAt.toISOString(),
                };
            } else if (session.exhausted) {
                feedPosts = [];
                explicitNextCursor = null;
                forYouResponseMeta = {
                    algorithm: FOR_YOU_ALGORITHM,
                    candidateCount: eligiblePosts.length,
                    remainingCount: 0,
                    sessionExpiresAt: session.expiresAt.toISOString(),
                };
            } else {
                const servedRows = await db.select({ postKey: forYouFeedItems.postKey })
                    .from(forYouFeedItems)
                    .where(eq(forYouFeedItems.sessionId, session.id));
                const servedKeys = new Set(servedRows.map((row) => row.postKey));
                const unservedCandidates = eligiblePosts.filter((post) => !servedKeys.has(forYouPostKey(post)));
                const viewerSignals = await buildForYouViewerSignals({
                    viewer,
                    candidates: eligiblePosts,
                    snapshotAt: session.snapshotAt,
                    localNodeDomain: localDomain,
                });
                const ranked = rankForYouFeed(unservedCandidates, viewerSignals, {
                    limit,
                    snapshotAt: session.snapshotAt.getTime(),
                    state: parseForYouDiversityState(session.diversityStateJson),
                });
                if (ranked.posts.length > 0) {
                    await db.insert(forYouFeedItems).values(ranked.posts.map((post, index) => ({
                        sessionId: session.id,
                        position: session.nextPosition + index,
                        postKey: forYouPostKey(post),
                        feedMetaJson: JSON.stringify(post.feedMeta),
                    })));
                }
                const nextPosition = session.nextPosition + ranked.posts.length;
                const exhausted = ranked.remainingCount === 0;
                await db.update(forYouFeedSessions).set({
                    nextPosition,
                    diversityStateJson: JSON.stringify(ranked.state),
                    exhausted,
                    updatedAt: now,
                }).where(eq(forYouFeedSessions.id, session.id));
                feedPosts = ranked.posts;
                explicitNextCursor = exhausted ? null : encodeForYouCursor(session.id, nextPosition);
                forYouResponseMeta = {
                    algorithm: FOR_YOU_ALGORITHM,
                    candidateCount: eligiblePosts.length,
                    remainingCount: ranked.remainingCount,
                    personalizationConfidence: Number(viewerSignals.personalizationConfidence.toFixed(3)),
                    sessionExpiresAt: session.expiresAt.toISOString(),
                };
            }
        } else {
            // Home timeline - need auth
            try {
                const user = await requireAuth();

                // Get IDs of users the current user follows
                const followRows = await db.select({ followingId: follows.followingId })
                    .from(follows)
                    .where(eq(follows.followerId, user.id));
                const followingIds = followRows.map(row => row.followingId);

                // Include own posts + posts from followed users
                const allowedUserIds = [user.id, ...followingIds];

                // Build where condition with cursor support
                let whereCondition = {
                    ...baseFilter,
                    userId: { in: allowedUserIds },
                    createdAt: undefined as { lt: Date } | undefined,
                };
                const cursorDate = await getMixedFeedCursorDate(cursor);

                if (cursorDate) {
                    whereCondition = { ...baseFilter, userId: { in: allowedUserIds }, createdAt: { lt: cursorDate } };
                }

                // Get local posts from people the user follows + their own posts
                const localPosts = await db.query.posts.findMany({
                    where: whereCondition,
                    with: feedPostRelations,
                    orderBy: (posts, { desc }) => [desc(posts.createdAt)],
                    limit: cursor ? limit : limit * 2, // Get more on first load to account for mixing with remote
                });

                const swarmRepostWhere = {
                    userId: { in: allowedUserIds },
                    ...(cursorDate ? { repostedAt: { lt: cursorDate } } : {}),
                };
                const swarmRepostRows = await db.query.userSwarmReposts.findMany({
                    where: swarmRepostWhere,
                    orderBy: (userSwarmReposts, { desc }) => [desc(userSwarmReposts.repostedAt)],
                    limit: cursor ? limit : limit * 2,
                });

                const swarmRepostAuthors = swarmRepostRows.length > 0
                    ? await db.query.users.findMany({
                        where: { id: { in: Array.from(new Set(swarmRepostRows.map((row) => row.userId))) } },
                    })
                    : [];
                const swarmRepostAuthorMap = new Map(swarmRepostAuthors.map((author) => [author.id, author]));
                const localRepostEvents = swarmRepostRows
                    .map((row) => {
                        const author = swarmRepostAuthorMap.get(row.userId);
                        if (!author) {
                            return null;
                        }
                        return mapUserSwarmRepostToFeedPost(row, author);
                    })
                    .filter((post): post is FeedPostWithChildren => post !== null);

                // Let the database join cached authors to the viewer's remote
                // follows. Feed cost stays page-sized even with 5,000+ follows.
                const cachedRemoteTimeline = await getCachedSwarmTimeline({
                    limit: cursor ? limit : limit * 2,
                    cursor: decodeFeedCursorPosition(cursor) || cursorDate,
                    includeNsfw: true,
                    followedByUserId: user.id,
                    excludeDomains: excludedRemoteDomains,
                });
                const cachedRemotePosts = cachedRemoteTimeline.posts.map((post) =>
                    mapSwarmPostToPost(post, {
                        localDomain: getLocalAccountHomeDomain(),
                    }));

                // Merge and sort by date
                const allPosts = collapseSharedFeedPosts([
                    ...localPosts,
                    ...localRepostEvents,
                    ...cachedRemotePosts,
                ] as unknown as Post[], getLocalAccountHomeDomain())
                    .slice(0, limit);

                feedPosts = allPosts;
            } catch {
                // Not authenticated, return public timeline
                feedPosts = await db.query.posts.findMany({
                    where: baseFilter,
                    with: feedPostRelations,
                    orderBy: (posts, { desc }) => [desc(posts.createdAt)],
                    limit,
                });
            }
        }

        // Populate isLiked and isReposted for authenticated users
        try {
            const { getSession } = await import('@/lib/auth');
            const session = await getSession();

            if (session?.user && feedPosts && feedPosts.length > 0) {
                const viewer = session.user;
                const nodeDomain = getLocalAccountHomeDomain();
                const allFeedPosts = collectNestedPosts(feedPosts as FeedPostWithChildren[]);

                // Separate local and swarm posts
                const localPostIds: string[] = [];
                const swarmPosts: Array<{ id: string; domain: string; originalId: string }> = [];

                for (const p of allFeedPosts) {
                    if (p.id.startsWith('swarm:')) {
                        const parts = p.id.split(':');
                        if (parts.length >= 3) {
                            swarmPosts.push({
                                id: p.id,
                                domain: parts[1],
                                originalId: parts[2],
                            });
                        }
                    } else {
                        localPostIds.push(p.id);
                    }
                }

                // Check local likes
                const likedPostIds = new Set<string>();
                const repostedPostIds = new Set<string>();

                if (localPostIds.length > 0) {
                    const [viewerLikes, legacySameNodeLikes, legacySameNodeReposts] = await Promise.all([
                        db.query.likes.findMany({
                            where: { AND: [{ userId: viewer.id }, { postId: { in: localPostIds } }] },
                        }),
                        db.query.userSwarmLikes.findMany({
                            where: { AND: [{ userId: viewer.id }, { nodeDomain }, { originalPostId: { in: localPostIds } }] },
                        }),
                        db.query.userSwarmReposts.findMany({
                            where: { AND: [{ userId: viewer.id }, { nodeDomain }, { originalPostId: { in: localPostIds } }] },
                        }),
                    ]);
                    viewerLikes.forEach(l => likedPostIds.add(l.postId));
                    legacySameNodeLikes.forEach(l => likedPostIds.add(l.originalPostId));
                    legacySameNodeReposts.forEach(r => repostedPostIds.add(r.originalPostId));

                    const viewerReposts = await db.query.posts.findMany({
                        where: { AND: [{ userId: viewer.id }, { repostOfId: { in: localPostIds } }, { isRemoved: false }] },
                    });
                    viewerReposts.forEach(r => { if (r.repostOfId) repostedPostIds.add(r.repostOfId); });
                }

                // Local interaction ledgers are authoritative for this viewer.
                // Never add per-post federation calls to feed rendering.
                if (swarmPosts.length > 0) {
                    const { getViewerSwarmRepostedPostIds } = await import('@/lib/swarm/reposts');
                    const swarmLikedIds = await getViewerSwarmLikedPostIds(
                        swarmPosts.map((sp) => ({
                            id: sp.id,
                            nodeDomain: sp.domain,
                            originalPostId: sp.originalId,
                        })),
                        viewer.id,
                    );
                    swarmLikedIds.forEach((id) => likedPostIds.add(id));

                    const swarmRepostedIds = await getViewerSwarmRepostedPostIds(
                        swarmPosts.map((sp) => ({
                            id: sp.id,
                            nodeDomain: sp.domain,
                            originalPostId: sp.originalId,
                        })),
                        viewer.id
                    );
                    swarmRepostedIds.forEach((id) => repostedPostIds.add(id));
                }

                feedPosts = applyInteractionFlags(
                    feedPosts as FeedPostWithChildren[],
                    likedPostIds,
                    repostedPostIds,
                    {
                        id: viewer.id,
                        handle: viewer.handle,
                        displayName: viewer.displayName,
                        avatarUrl: viewer.avatarUrl,
                        isNsfw: viewer.isNsfw,
                        nodeDomain,
                    },
                );
            }
        } catch (error) {
            console.error('Error populating interaction flags:', error);
        }

        const lastFeedPost = feedPosts?.length
            ? feedPosts[feedPosts.length - 1] as FeedPostWithChildren
            : undefined;
        const canViewSensitive = shouldIncludeNsfwFeed({
            viewer: requestSession?.user ?? null,
            localNodeIsNsfw,
        });
        const serializedFeedPosts = (feedPosts || []).map((post) => (
            redactSensitivePostForViewer(attachStoredStuffboxBadgesToPost(post) as unknown as Record<string, unknown>, {
                canViewSensitive,
                localNodeDomain: getLocalAccountHomeDomain(),
                localNodeIsNsfw,
            })
        ));

        return NextResponse.json({
            posts: serializedFeedPosts,
            meta: forYouResponseMeta,
            nextCursor: explicitNextCursor !== undefined
                ? explicitNextCursor
                : (feedPosts?.length === limit)
                ? (type === 'home' || type === 'local'
                    ? (lastFeedPost
                        ? encodeFeedCursor({
                            at: lastFeedPost.feedActivityAt || lastFeedPost.createdAt,
                            id: lastFeedPost.id,
                        })
                        : null)
                    : lastFeedPost?.id)
                : null,
        });
    } catch (error) {
        console.error('Get feed error details:', error);
        return NextResponse.json(
            { error: 'Failed to get feed' },
            { status: 500 }
        );
    }
}
