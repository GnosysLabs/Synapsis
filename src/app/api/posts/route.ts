import { NextResponse } from 'next/server';
import { db, posts, users, media, follows, mutes, blocks, remotePosts, remoteReposts, userSwarmReposts, notifications } from '@/db';
import { getSession, requireAuth } from '@/lib/auth';
import { requireSignedAction, SignedActionError, type SignedAction } from '@/lib/auth/verify-signature';
import {
    isCliSignedAction,
    requireCliSignedAction,
    signedActionErrorStatus,
} from '@/lib/auth/cli-credentials';
import { eq, and, desc, inArray, isNull, lt, ne, notLike, sql } from 'drizzle-orm';
import { z } from 'zod';
import { serializeLinkPreviewMedia, parseLinkPreviewMediaJson } from '@/lib/media/linkPreview';
import { shouldIncludeNsfwFeed } from '@/lib/nsfw/feed-access';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { hasPublishablePostContent } from '@/lib/posts/content-policy';
import { decodeFeedCursor, encodeFeedCursor, newestDate, selectFeedWindow } from '@/lib/posts/feed-pagination';
import { mapSwarmPostToPost } from '@/lib/swarm/feed-post';
import { hasStrictLocalUserOrigin } from '@/lib/swarm/local-user-origin';
import {
    CURATED_FEED_WEIGHTS,
    CURATED_FEED_WINDOW_HOURS,
    rankCuratedFeed,
} from '@/lib/posts/curated-feed';
import { registerPostMentions } from '@/lib/mentions/delivery';
import {
    assembleNodeFeedStories,
    collapseSharedFeedPosts,
    mergeNodeFeedActivities,
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
import { signedFederationRead } from '@/lib/swarm/signed-read';
import { refreshFederatedReplyCounts } from '@/lib/swarm/reply-counts';

const POST_MAX_LENGTH = 600;
const CURATION_SEED_MULTIPLIER = 5;
const CURATION_SEED_CAP = 200;

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
        displayName: string | null;
        avatarUrl: string | null;
        isNsfw: boolean;
        nodeDomain?: string | null;
    }>;
    repostedByCount?: number;
};

function mapUserSwarmRepostToFeedPost(
    row: typeof userSwarmReposts.$inferSelect,
    author: Pick<typeof users.$inferSelect, 'id' | 'handle' | 'displayName' | 'avatarUrl' | 'isNsfw'>
): FeedPostWithChildren {
    const localNodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';
    const remoteAuthorHandle = row.authorHandle.includes('@')
        ? row.authorHandle
        : `${row.authorHandle}@${row.nodeDomain}`;
    const remoteOriginalId = `swarm:${row.nodeDomain}:${row.originalPostId}`;

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
        },
        repostOfId: remoteOriginalId,
        repostOf: {
            id: remoteOriginalId,
            originalPostId: row.originalPostId,
            content: row.content,
            createdAt: row.postCreatedAt.toISOString(),
            likesCount: row.likesCount,
            repostsCount: row.repostsCount,
            repliesCount: row.repliesCount,
            isSwarm: true,
            nodeDomain: row.nodeDomain,
            // Legacy cached repost snapshots predate sensitivity columns.
            // Leave classifiers unknown so the shared renderer fails closed.
            isNsfw: undefined,
            nodeIsNsfw: undefined,
            author: {
                id: `swarm:${row.nodeDomain}:${row.authorHandle}`,
                handle: remoteAuthorHandle,
                displayName: row.authorDisplayName || row.authorHandle,
                avatarUrl: row.authorAvatarUrl,
                isRemote: true,
                nodeDomain: row.nodeDomain,
                isNsfw: undefined,
                nodeIsNsfw: undefined,
            },
            media: row.mediaJson ? JSON.parse(row.mediaJson) : [],
            linkPreviewUrl: row.linkPreviewUrl,
            linkPreviewTitle: row.linkPreviewTitle,
            linkPreviewDescription: row.linkPreviewDescription,
            linkPreviewImage: row.linkPreviewImage,
            linkPreviewType: row.linkPreviewType,
            linkPreviewVideoUrl: row.linkPreviewVideoUrl,
            linkPreviewMedia: parseLinkPreviewMediaJson(row.linkPreviewMediaJson) || null,
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

async function getLocalNodeFeed(cursor: string | null, limit: number): Promise<FeedPostWithChildren[]> {
    const localNodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';
    const storyId = sql<string>`coalesce(${posts.repostOfId}, ${posts.id})`;
    const latestActivityAt = sql<Date>`max(${posts.createdAt})`.mapWith(posts.createdAt);
    const latestRemoteActivityAt = sql<Date>`max(
        max(${remoteReposts.createdAt}),
        coalesce((
            select max("activity_posts"."created_at")
            from "posts" "activity_posts"
            inner join "users" "activity_users"
              on "activity_posts"."user_id" = "activity_users"."id"
            where coalesce("activity_posts"."repost_of_id", "activity_posts"."id") = ${remoteReposts.postId}
              and "activity_posts"."is_removed" = 0
              and "activity_posts"."reply_to_id" is null
              and "activity_posts"."swarm_reply_to_id" is null
              and "activity_users"."node_id" is null
              and "activity_users"."handle" not like '%@%'
        ), 0)
    )`.mapWith(posts.createdAt);
    const cursorDate = decodeFeedCursor(cursor);

    const activityQuery = db.select({
        storyId,
        latestActivityAt,
    })
        .from(posts)
        .innerJoin(users, eq(posts.userId, users.id))
        .where(and(
            eq(posts.isRemoved, false),
            isNull(posts.replyToId),
            isNull(posts.swarmReplyToId),
            isNull(users.nodeId),
            notLike(users.handle, '%@%'),
            sql`not exists (
                select 1 from ${remoteReposts}
                where ${remoteReposts.postId} = ${storyId}
            )`,
        ))
        .groupBy(storyId)
        .orderBy(desc(latestActivityAt))
        .limit(limit);

    const localActivityRows = cursorDate
        ? await activityQuery.having(lt(latestActivityAt, cursorDate))
        : await activityQuery;
    const remoteActivityQuery = db.select({
        storyId: remoteReposts.postId,
        latestActivityAt: latestRemoteActivityAt,
    })
        .from(remoteReposts)
        .innerJoin(posts, eq(remoteReposts.postId, posts.id))
        .innerJoin(users, eq(posts.userId, users.id))
        .where(and(
            eq(posts.isRemoved, false),
            isNull(posts.replyToId),
            isNull(posts.swarmReplyToId),
            isNull(users.nodeId),
            notLike(users.handle, '%@%'),
        ))
        .groupBy(remoteReposts.postId)
        .orderBy(desc(latestRemoteActivityAt))
        .limit(limit);
    const remoteActivityRows = cursorDate
        ? await remoteActivityQuery.having(lt(latestRemoteActivityAt, cursorDate))
        : await remoteActivityQuery;
    const activityRows = mergeNodeFeedActivities(
        [localActivityRows, remoteActivityRows],
        limit,
    );
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
    limit: number,
): Promise<FeedPostWithChildren[]> {
    const latestActivityAt = sql<Date>`max(${userSwarmReposts.repostedAt})`.mapWith(userSwarmReposts.repostedAt);
    const cursorDate = decodeFeedCursor(cursor);
    const localDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';
    const activityQuery = db.select({
        nodeDomain: userSwarmReposts.nodeDomain,
        originalPostId: userSwarmReposts.originalPostId,
        latestActivityAt,
    })
        .from(userSwarmReposts)
        .where(ne(userSwarmReposts.nodeDomain, localDomain))
        .groupBy(userSwarmReposts.nodeDomain, userSwarmReposts.originalPostId)
        .orderBy(desc(latestActivityAt))
        .limit(limit);
    const activityRows = cursorDate
        ? await activityQuery.having(lt(latestActivityAt, cursorDate))
        : await activityQuery;

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
        const data = createPostSchema.parse(
            isCliSignedAction(requestBody) || isSignedActionPayload(requestBody)
                ? requestBody.data
                : requestBody
        );

        if (user.isSuspended || user.isSilenced) {
            return NextResponse.json({ error: 'Account restricted' }, { status: 403 });
        }

        const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';

        // Build swarm reply fields if replying to a swarm post
        const swarmReplyFields = data.swarmReplyTo ? {
            swarmReplyToId: `swarm:${data.swarmReplyTo.nodeDomain}:${data.swarmReplyTo.postId}`,
            swarmReplyToContent: data.swarmReplyTo.content?.slice(0, 300) || null,
            swarmReplyToAuthor: data.swarmReplyTo.author ? JSON.stringify({
                handle: data.swarmReplyTo.author.handle,
                displayName: data.swarmReplyTo.author.displayName,
                avatarUrl: data.swarmReplyTo.author.avatarUrl,
                nodeDomain: data.swarmReplyTo.nodeDomain,
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

        const postContent = data.content.trim();
        if (!hasPublishablePostContent(postContent, unattachedMedia.map(item => item.id))) {
            return NextResponse.json(
                { error: 'Add text or attach media before posting.' },
                { status: 400 },
            );
        }

        const [post] = await db.insert(posts).values({
            userId: user.id,
            content: postContent,
            replyToId: data.replyToId,
            ...swarmReplyFields,
            isNsfw: data.isNsfw || user.isNsfw || false, // Inherit from account if account is NSFW
            apId: `https://${nodeDomain}/posts/${crypto.randomUUID()}`,
            apUrl: `https://${nodeDomain}/posts/${crypto.randomUUID()}`,
            linkPreviewUrl: data.linkPreview?.url,
            linkPreviewTitle: data.linkPreview?.title,
            linkPreviewDescription: data.linkPreview?.description,
            linkPreviewImage: data.linkPreview?.image,
            linkPreviewType: data.linkPreview?.type,
            linkPreviewVideoUrl: data.linkPreview?.videoUrl,
            linkPreviewMediaJson: serializeLinkPreviewMedia(data.linkPreview?.media),
        }).returning();

        try {
            if (data.swarmReplyTo) {
                const nodeIsNsfw = await requireLocalNodeNsfwClassification();
                const protocol = data.swarmReplyTo.nodeDomain.includes('localhost') ? 'http' : 'https';
                const targetUrl = `${protocol}://${data.swarmReplyTo.nodeDomain}/api/swarm/replies`;

                const replyPayload = {
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
                        },
                        nodeDomain,
                        nodeIsNsfw,
                        isNsfw: post.isNsfw,
                        mediaUrls: unattachedMedia.map(m => m.url),
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
                    const body = response.text();
                    throw new Error(body || `Remote node rejected reply (${response.status})`);
                }
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
                        actorNodeDomain: null,
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
            });
        } catch (err) {
            console.error('[Posts] Error registering mentions:', err);
            console.error('[Posts] Context:', { postId: post.id, userId: user.id, content: postContent.slice(0, 100) });
        }

        // Federate the post to remote followers (non-blocking)
        (async () => {
            try {
                // SWARM-FIRST: Deliver to swarm followers directly
                const { deliverPostToSwarmFollowers } = await import('@/lib/swarm/interactions');

                const swarmResult = await deliverPostToSwarmFollowers(
                    user.id,
                    post,
                    {
                        handle: user.handle,
                        displayName: user.displayName,
                        avatarUrl: user.avatarUrl,
                        isNsfw: user.isNsfw,
                    },
                    attachedMedia,
                    nodeDomain
                );

                if (swarmResult.delivered > 0) {
                    console.log(`[Swarm] Post ${post.id} delivered to ${swarmResult.delivered} swarm nodes (${swarmResult.failed} failed)`);
                }
            } catch (err) {
                // Log error with context but don't fail the request - swarm delivery is best-effort
                console.error('[Posts] Error delivering post to swarm followers:', err);
                console.error('[Posts] Context:', { postId: post.id, userId: user.id, nodeDomain });
            }
        })();


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

// Normalize content for deduplication (strip HTML entities, URLs, whitespace, category suffixes)
const normalizeForDedup = (content: string): string => {
    return content
        .replace(/Posted into [\w\s-]+/gi, '') // Remove "Posted into [Category]" patterns
        .replace(/&[a-z]+;/gi, '') // Remove HTML entities like &lsquo;
        .replace(/&#\d+;/g, '') // Remove numeric entities
        .replace(/https?:\/\/[^\s]+/gi, '') // Remove URLs
        .replace(/[^\w\s]/g, '') // Remove punctuation
        .replace(/\s+/g, ' ') // Normalize whitespace
        .toLowerCase()
        .trim()
        .slice(0, 50); // Compare first 50 chars (article title)
};

// Helper to transform cached remote posts to match local post format
// Deduplicates by apId AND by similar content from same author
const transformRemotePosts = (remotePostsData: typeof remotePosts.$inferSelect[]) => {
    const seenApIds = new Set<string>();
    const seenContentKeys = new Set<string>(); // author+normalizedContent
    const uniquePosts: typeof remotePosts.$inferSelect[] = [];

    for (const rp of remotePostsData) {
        if (seenApIds.has(rp.apId)) continue;

        // Content-based dedup: same author + similar content = skip
        const contentKey = `${rp.authorHandle}:${normalizeForDedup(rp.content)}`;
        if (seenContentKeys.has(contentKey)) continue;

        seenApIds.add(rp.apId);
        seenContentKeys.add(contentKey);
        uniquePosts.push(rp);
    }

    return uniquePosts.map(rp => {
        const mediaData = rp.mediaJson ? JSON.parse(rp.mediaJson) : [];
        return {
            id: rp.id,
            content: rp.content,
            createdAt: rp.publishedAt,
            likesCount: 0,
            repostsCount: 0,
            repliesCount: 0,
            isRemote: true,
            apId: rp.apId,
            linkPreviewUrl: rp.linkPreviewUrl,
            linkPreviewTitle: rp.linkPreviewTitle,
            linkPreviewDescription: rp.linkPreviewDescription,
            linkPreviewImage: rp.linkPreviewImage,
            linkPreviewType: rp.linkPreviewType,
            linkPreviewVideoUrl: rp.linkPreviewVideoUrl,
            linkPreviewMedia: parseLinkPreviewMediaJson(rp.linkPreviewMediaJson) || null,
            author: {
                id: rp.authorActorUrl,
                handle: rp.authorHandle,
                displayName: rp.authorDisplayName,
                avatarUrl: rp.authorAvatarUrl,
                isRemote: true,
            },
            media: mediaData.map((m: { url: string; altText?: string }, idx: number) => ({
                id: `${rp.id}-media-${idx}`,
                url: m.url,
                altText: m.altText || null,
            })),
            replyTo: null,
        };
    });
};

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
        const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 50);
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

        let feedPosts;
        let explicitNextCursor: string | null | undefined;
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
            ] as unknown as Post[], process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821')
                .slice(0, limit) as FeedPostWithChildren[];
        } else if (type === 'public') {
            // Public timeline - all local posts + all cached remote posts
            const localPosts = await db.query.posts.findMany({
                where: baseFilter,
                with: feedPostRelations,
                orderBy: (posts, { desc }) => [desc(posts.createdAt)],
                limit: limit * 2,
            });

            // Get all cached remote posts
            const remotePostsData = await db.query.remotePosts.findMany({
                orderBy: (remotePosts, { desc }) => [desc(remotePosts.publishedAt)],
                limit: limit,
            });

            const transformedRemote = transformRemotePosts(remotePostsData);

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
        } else if (type === 'curated') {
            // Curated feed - swarm posts only
            const viewer = requestSession?.user ?? null;
            const includeNsfw = shouldIncludeNsfwFeed({
                viewer,
                localNodeIsNsfw,
            });

            // Fetch swarm posts with user's NSFW preference
            const { fetchSwarmTimeline } = await import('@/lib/swarm/timeline');
            const cursorDate = await getMixedFeedCursorDate(cursor);
            const swarmResult = await fetchSwarmTimeline(undefined, 30, {
                includeNsfw,
                cursor: cursorDate?.toISOString(),
            });

            console.log('[Curated Feed] Swarm result:', {
                postsCount: swarmResult.posts.length,
                sources: swarmResult.sources,
                includeNsfw,
            });

            const localDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';
            const swarmPosts = swarmResult.posts.map((post) => mapSwarmPostToPost(post, { localDomain }));
            const locallyRepostedRemoteStories = await getLocallyRepostedRemoteStories(cursor, limit);

            let mutedIds = new Set<string>();
            let blockedIds = new Set<string>();

            if (viewer) {
                const muteRows = await db.select({ mutedUserId: mutes.mutedUserId })
                    .from(mutes)
                    .where(eq(mutes.userId, viewer.id));
                mutedIds = new Set(muteRows.map(row => row.mutedUserId));

                const blockRows = await db.select({ blockedUserId: blocks.blockedUserId })
                    .from(blocks)
                    .where(eq(blocks.userId, viewer.id));
                blockedIds = new Set(blockRows.map(row => row.blockedUserId));
            }

            const eligiblePosts = collapseSharedFeedPosts([
                ...swarmPosts,
                ...locallyRepostedRemoteStories as unknown as Post[],
            ], localDomain)
                .filter((post) => !mutedIds.has(post.author.id) && !blockedIds.has(post.author.id));
            const pageWindow = selectFeedWindow(eligiblePosts, limit);
            const rankedPosts = rankCuratedFeed(pageWindow.posts, { limit });
            const localRepostContinuation = locallyRepostedRemoteStories.length >= limit
                ? new Date(locallyRepostedRemoteStories[locallyRepostedRemoteStories.length - 1].feedActivityAt || locallyRepostedRemoteStories[locallyRepostedRemoteStories.length - 1].createdAt)
                : null;
            const sourceContinuation = newestDate([
                swarmResult.continuationDate ? new Date(swarmResult.continuationDate) : null,
                localRepostContinuation,
            ]);
            explicitNextCursor = encodeFeedCursor(
                pageWindow.hasOverflow ? pageWindow.oldestActivityAt : sourceContinuation,
            );

            console.log('[Curated Feed] After ranking:', {
                swarmPostsCount: swarmPosts.length,
                afterMuteFilter: eligiblePosts.length,
                rankedPostsCount: rankedPosts.length,
                limit,
            });

            feedPosts = rankedPosts;
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

                // Get handles of remote users we follow
                const followedRemoteUsers = await db.query.remoteFollows.findMany({
                    where: { followerId: user.id },
                });

                // Fetch posts LIVE from followed remote users (in parallel, with timeout)
                let liveRemotePosts: import('@/lib/swarm/remote-profile-posts').RemoteProfilePost[] = [];
                if (followedRemoteUsers.length > 0) {
                    const { fetchSwarmUserProfile, isSwarmNode } = await import('@/lib/swarm/interactions');
                    const { mapRemoteProfilePost } = await import('@/lib/swarm/remote-profile-posts');

                    // Wrap each fetch with a timeout to prevent slow nodes from blocking
                    const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | null> => {
                        return Promise.race([
                            promise,
                            new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))
                        ]);
                    };

                    const fetchPromises = followedRemoteUsers.map(async (follow) => {
                        try {
                            const atIndex = follow.targetHandle.lastIndexOf('@');
                            if (atIndex === -1) return [];

                            const handle = follow.targetHandle.slice(0, atIndex);
                            const domain = follow.targetHandle.slice(atIndex + 1);

                            // Only fetch from swarm nodes
                            const isSwarm = await isSwarmNode(domain);
                            if (!isSwarm) return [];

                            const profileData = await withTimeout(
                                fetchSwarmUserProfile(handle, domain, limit, cursorDate?.toISOString()),
                                5000 // 5s timeout per node
                            );
                            if (!profileData?.posts) return [];

                            const profileIsNsfw = profileData.profile.isNsfw;
                            const profileNodeIsNsfw = profileData.profile.nodeIsNsfw;

                            return profileData.posts
                                .filter((post) => !post.replyToId && !post.swarmReplyToId && !post.isReply)
                                .filter((post) => !cursorDate || new Date(post.createdAt) < cursorDate)
                                .map((post) => mapRemoteProfilePost({
                                    ...post,
                                    isNsfw: post.isNsfw || profileIsNsfw || profileNodeIsNsfw,
                                    nodeDomain: post.nodeDomain || domain,
                                    author: {
                                        ...(post.author || {
                                            handle,
                                            displayName: follow.displayName || profileData.profile?.displayName || handle,
                                            avatarUrl: follow.avatarUrl || profileData.profile?.avatarUrl,
                                        }),
                                        isNsfw: post.author?.isNsfw ?? profileIsNsfw,
                                        nodeIsNsfw: post.author?.nodeIsNsfw ?? profileNodeIsNsfw,
                                        nodeDomain: post.author?.nodeDomain || domain,
                                    },
                                } as unknown as import('@/lib/swarm/remote-profile-posts').RemoteProfilePost, domain));
                        } catch (error) {
                            console.error(`[Home] Error fetching posts from ${follow.targetHandle}:`, error);
                            return [];
                        }
                    });

                    const results = await Promise.all(fetchPromises);
                    liveRemotePosts = results.flat();
                }

                // Merge and sort by date
                const allPosts = collapseSharedFeedPosts([
                    ...localPosts,
                    ...localRepostEvents,
                    ...liveRemotePosts,
                ] as unknown as Post[], process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821')
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
                const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';
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

                // Check swarm likes in real-time (query origin nodes)
                if (swarmPosts.length > 0) {
                    const { getViewerSwarmRepostedPostIds } = await import('@/lib/swarm/reposts');

                    const checkPromises = swarmPosts.map(async (sp) => {
                        try {
                            const protocol = sp.domain.includes('localhost') ? 'http' : 'https';
                            const url = `${protocol}://${sp.domain}/api/swarm/posts/${sp.originalId}/likes?checkHandle=${viewer.handle}&checkDomain=${nodeDomain}`;

                            const res = await signedFederationRead(url, {
                                headers: { 'Accept': 'application/json' },
                                timeoutMs: 3_000,
                                maxResponseBytes: 32 * 1024,
                            });

                            if (res.status >= 200 && res.status < 300) {
                                const data = res.json() as { isLiked?: boolean };
                                if (data.isLiked) {
                                    likedPostIds.add(sp.id);
                                }
                            }
                        } catch {
                            // Timeout or error - just skip
                        }
                    });

                    await Promise.all(checkPromises);

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
            redactSensitivePostForViewer(post as unknown as Record<string, unknown>, {
                canViewSensitive,
                localNodeDomain: process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
                localNodeIsNsfw,
            })
        ));

        return NextResponse.json({
            posts: serializedFeedPosts,
            meta: type === 'curated' ? {
                algorithm: 'curated-v2-diversity',
                windowHours: CURATED_FEED_WINDOW_HOURS,
                seedLimit: Math.min(limit * CURATION_SEED_MULTIPLIER, CURATION_SEED_CAP),
                weights: {
                    ...CURATED_FEED_WEIGHTS,
                },
            } : undefined,
            nextCursor: explicitNextCursor !== undefined
                ? explicitNextCursor
                : (feedPosts?.length === limit)
                ? (type === 'home' || type === 'curated' || type === 'local'
                    ? encodeFeedCursor(lastFeedPost?.feedActivityAt || lastFeedPost?.createdAt)
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
