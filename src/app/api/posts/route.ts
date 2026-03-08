import { NextResponse } from 'next/server';
import { db, posts, users, media, follows, mutes, blocks, likes, remoteFollows, remotePosts } from '@/db';
import { requireAuth } from '@/lib/auth';
import { requireSignedAction, type SignedAction } from '@/lib/auth/verify-signature';
import { eq, desc, and, inArray, isNull, isNotNull, or, lt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { z } from 'zod';

const POST_MAX_LENGTH = 600;
const CURATION_WINDOW_HOURS = 72;
const CURATION_SEED_MULTIPLIER = 5;
const CURATION_SEED_CAP = 200;

const buildWhere = (...conditions: Array<SQL | undefined>) => {
    const filtered = conditions.filter(Boolean) as SQL[];
    if (filtered.length === 0) return undefined;
    return and(...filtered);
};

const createPostSchema = z.object({
    content: z.string().min(1).max(POST_MAX_LENGTH),
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
    }).optional().nullable(),
});

// Create a new post
export async function POST(request: Request) {
    try {
        // Parse the signed action from the request body
        const signedAction: SignedAction = await request.json();

        // Strictly verify the signature and get the user
        // This replaces requireAuth() - the signature proves identity AND intent
        const user = await requireSignedAction(signedAction);

        // Extract post data from the signed action
        const data = createPostSchema.parse(signedAction.data);

        if (user.isSuspended || user.isSilenced) {
            return NextResponse.json({ error: 'Account restricted' }, { status: 403 });
        }

        const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:3000';

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

        const [post] = await db.insert(posts).values({
            userId: user.id,
            content: data.content,
            replyToId: data.replyToId,
            ...swarmReplyFields,
            isNsfw: data.isNsfw || user.isNsfw || false, // Inherit from account if account is NSFW
            apId: `https://${nodeDomain}/posts/${crypto.randomUUID()}`,
            apUrl: `https://${nodeDomain}/posts/${crypto.randomUUID()}`,
            linkPreviewUrl: data.linkPreview?.url,
            linkPreviewTitle: data.linkPreview?.title,
            linkPreviewDescription: data.linkPreview?.description,
            linkPreviewImage: data.linkPreview?.image,
        }).returning();

        let attachedMedia: typeof media.$inferSelect[] = [];
        if (data.mediaIds?.length) {
            await db.update(media)
                .set({ postId: post.id })
                .where(and(
                    inArray(media.id, data.mediaIds),
                    eq(media.userId, user.id),
                    isNull(media.postId),
                ));

            attachedMedia = await db.query.media.findMany({
                where: and(
                    inArray(media.id, data.mediaIds),
                    eq(media.userId, user.id),
                    eq(media.postId, post.id),
                ),
            });
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

        // DEPRECATED: Push-based federation disabled
        // Swarm now uses real-time pull-based federation
        // Replies are fetched in real-time from the origin node
        /*
        if (data.swarmReplyTo) {
            (async () => {
                try {
                    const targetUrl = `https://${data.swarmReplyTo!.nodeDomain}/api/swarm/replies`;

                    const replyPayload = {
                        postId: data.swarmReplyTo!.postId,
                        reply: {
                            id: post.id,
                            content: post.content,
                            createdAt: post.createdAt.toISOString(),
                            author: {
                                handle: user.handle,
                                displayName: user.displayName || user.handle,
                                avatarUrl: user.avatarUrl || undefined,
                            },
                            nodeDomain,
                            mediaUrls: attachedMedia.map(m => m.url),
                        },
                    };

                    const response = await fetch(targetUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(replyPayload),
                    });

                    if (response.ok) {
                        console.log(`[Swarm] Reply delivered to ${data.swarmReplyTo!.nodeDomain}`);
                    } else {
                        console.error(`[Swarm] Failed to deliver reply: ${response.status}`);
                    }
                } catch (err) {
                    console.error('[Swarm] Error delivering reply:', err);
                }
            })();
        }
        */

        // Handle local mentions (create notifications for users on this node)
        (async () => {
            try {
                const { extractMentions } = await import('@/lib/swarm/interactions');
                const { notifications } = await import('@/db');

                const mentions = extractMentions(data.content);

                for (const mention of mentions) {
                    // Only handle local mentions (no domain)
                    if (mention.domain) continue;

                    // Find the mentioned user
                    const mentionedUser = await db.query.users.findFirst({
                        where: eq(users.handle, mention.handle.toLowerCase()),
                    });

                    if (mentionedUser && mentionedUser.id !== user.id && !mentionedUser.isSuspended) {
                        // Create notification for the mentioned user with actor info stored directly
                        await db.insert(notifications).values({
                            userId: mentionedUser.id,
                            actorId: user.id,
                            actorHandle: user.handle,
                            actorDisplayName: user.displayName,
                            actorAvatarUrl: user.avatarUrl,
                            actorNodeDomain: null, // Local user
                            postId: post.id,
                            postContent: post.content?.slice(0, 200) || null,
                            type: 'mention',
                        });

                        // Also notify bot owner if this is a bot being mentioned
                        if (mentionedUser.isBot && mentionedUser.botOwnerId) {
                            await db.insert(notifications).values({
                                userId: mentionedUser.botOwnerId,
                                actorId: user.id,
                                actorHandle: user.handle,
                                actorDisplayName: user.displayName,
                                actorAvatarUrl: user.avatarUrl,
                                actorNodeDomain: null,
                                postId: post.id,
                                postContent: post.content?.slice(0, 200) || null,
                                type: 'mention',
                            });
                        }
                    }
                }
            } catch (err) {
                // Log error with context but don't fail the request - mention notifications are best-effort
                console.error('[Posts] Error creating mention notifications:', err);
                console.error('[Posts] Context:', { postId: post.id, userId: user.id, content: data.content?.slice(0, 100) });
            }
        })();

        // SWARM-FIRST: Deliver mentions to swarm nodes
        (async () => {
            try {
                const { deliverSwarmMentions } = await import('@/lib/swarm/interactions');

                const result = await deliverSwarmMentions(
                    data.content,
                    post.id,
                    {
                        handle: user.handle,
                        displayName: user.displayName || user.handle,
                        avatarUrl: user.avatarUrl || undefined,
                        nodeDomain,
                    }
                );

                if (result.delivered > 0) {
                    console.log(`[Swarm] Delivered ${result.delivered} mentions (${result.failed} failed)`);
                }
            } catch (err) {
                // Log error with context but don't fail the request - swarm delivery is best-effort
                console.error('[Posts] Error delivering swarm mentions:', err);
                console.error('[Posts] Context:', { postId: post.id, userId: user.id, nodeDomain });
            }
        })();

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

        let feedPosts;
        // Base filter excludes removed posts and replies (replies only show on detail/profile)
        const baseFilter = buildWhere(
            eq(posts.isRemoved, false),
            isNull(posts.replyToId),
            isNull(posts.swarmReplyToId)
        );
        // Filter for replies only
        const repliesFilter = buildWhere(
            eq(posts.isRemoved, false),
            or(
                isNotNull(posts.replyToId),
                isNotNull(posts.swarmReplyToId)
            )
        );

        if (type === 'local') {
            // Local node posts only
            let whereCondition = baseFilter;

            // Apply cursor-based pagination
            if (cursor) {
                const cursorPost = await db.query.posts.findFirst({
                    where: eq(posts.id, cursor),
                });
                if (cursorPost) {
                    whereCondition = buildWhere(baseFilter, lt(posts.createdAt, cursorPost.createdAt));
                }
            }

            feedPosts = await db.query.posts.findMany({
                where: whereCondition,
                with: {
                    author: true,
                    bot: true,
                    media: true,
                    replyTo: {
                        with: { author: true, media: true },
                    },
                },
                orderBy: [desc(posts.createdAt)],
                limit,
            });
        } else if (type === 'public') {
            // Public timeline - all local posts + all cached remote posts
            const localPosts = await db.query.posts.findMany({
                where: baseFilter,
                with: {
                    author: true,
                    bot: true,
                    media: true,
                    replyTo: {
                        with: { author: true, media: true },
                    },
                },
                orderBy: [desc(posts.createdAt)],
                limit: limit * 2,
            });

            // Get all cached remote posts
            const remotePostsData = await db.query.remotePosts.findMany({
                orderBy: [desc(remotePosts.publishedAt)],
                limit: limit,
            });

            const transformedRemote = transformRemotePosts(remotePostsData);

            // Merge and sort by date
            feedPosts = [...localPosts, ...transformedRemote]
                .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                .slice(0, limit) as any;
        } else if (type === 'user' && userId) {
            // User's posts (excluding replies)
            let whereCondition = buildWhere(baseFilter, eq(posts.userId, userId));

            // Apply cursor-based pagination
            if (cursor) {
                const cursorPost = await db.query.posts.findFirst({
                    where: eq(posts.id, cursor),
                });
                if (cursorPost) {
                    whereCondition = buildWhere(baseFilter, eq(posts.userId, userId), lt(posts.createdAt, cursorPost.createdAt));
                }
            }

            feedPosts = await db.query.posts.findMany({
                where: whereCondition,
                with: {
                    author: true,
                    bot: true,
                    media: true,
                    replyTo: {
                        with: { author: true, media: true },
                    },
                },
                orderBy: [desc(posts.createdAt)],
                limit,
            });
        } else if (type === 'replies' && userId) {
            // User's replies only
            let whereCondition = buildWhere(repliesFilter, eq(posts.userId, userId));

            // Apply cursor-based pagination
            if (cursor) {
                const cursorPost = await db.query.posts.findFirst({
                    where: eq(posts.id, cursor),
                });
                if (cursorPost) {
                    whereCondition = buildWhere(repliesFilter, eq(posts.userId, userId), lt(posts.createdAt, cursorPost.createdAt));
                }
            }

            feedPosts = await db.query.posts.findMany({
                where: whereCondition,
                with: {
                    author: true,
                    bot: true,
                    media: true,
                    replyTo: {
                        with: { author: true, media: true },
                    },
                },
                orderBy: [desc(posts.createdAt)],
                limit,
            });
        } else if (type === 'curated') {
            // Curated feed - swarm posts only
            let viewer = null;
            let includeNsfw = false;
            try {
                const { getSession } = await import('@/lib/auth');
                const session = await getSession();
                viewer = session?.user || null;
                includeNsfw = session?.user?.nsfwEnabled ?? false;
            } catch {
                viewer = null;
                includeNsfw = false;
            }

            // Fetch swarm posts with user's NSFW preference
            const { fetchSwarmTimeline } = await import('@/lib/swarm/timeline');
            const swarmResult = await fetchSwarmTimeline(10, 30, { includeNsfw });

            console.log('[Curated Feed] Swarm result:', {
                postsCount: swarmResult.posts.length,
                sources: swarmResult.sources,
                includeNsfw,
            });

            // Transform swarm posts to match local post format
            const swarmPosts = swarmResult.posts.map(sp => ({
                id: `swarm:${sp.nodeDomain}:${sp.id}`,
                originalPostId: sp.id, // Keep the original ID for replies
                content: sp.content,
                createdAt: new Date(sp.createdAt),
                likesCount: sp.likeCount,
                repostsCount: sp.repostCount,
                repliesCount: sp.replyCount,
                isSwarm: true,
                nodeDomain: sp.nodeDomain,
                author: {
                    id: `swarm:${sp.nodeDomain}:${sp.author.handle}`,
                    handle: sp.author.handle,
                    displayName: sp.author.displayName,
                    avatarUrl: sp.author.avatarUrl,
                    isSwarm: true,
                    isBot: sp.author.isBot,
                    nodeDomain: sp.nodeDomain,
                },
                media: sp.media?.map((m, idx) => ({
                    id: `swarm:${sp.nodeDomain}:${sp.id}:media:${idx}`,
                    url: m.url,
                    altText: m.altText || null,
                    mimeType: m.mimeType || null,
                })) || [],
                linkPreviewUrl: sp.linkPreviewUrl || null,
                linkPreviewTitle: sp.linkPreviewTitle || null,
                linkPreviewDescription: sp.linkPreviewDescription || null,
                linkPreviewImage: sp.linkPreviewImage || null,
                replyTo: null,
            }));

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

            const now = Date.now();
            const rankedPosts = swarmPosts
                .filter((post: any) => !mutedIds.has(post.author.id) && !blockedIds.has(post.author.id))
                .map((post: any) => {
                    const createdAt = new Date(post.createdAt).getTime();
                    const ageHours = Math.max(0, (now - createdAt) / 3600000);
                    const engagement = (post.likesCount || 0) + (post.repostsCount || 0) * 2 + (post.repliesCount || 0) * 0.5;
                    const engagementScore = Math.log1p(Math.max(0, engagement));
                    const recencyScore = Math.max(0, 1 - ageHours / CURATION_WINDOW_HOURS);

                    const score = engagementScore * 1.4 + recencyScore * 1.1;

                    const reasons: string[] = [];
                    reasons.push(`From ${post.nodeDomain}`);
                    if (engagement >= 5) {
                        reasons.push(`Popular: ${post.likesCount || 0} likes, ${post.repostsCount || 0} reposts`);
                    } else if ((post.repliesCount || 0) > 0) {
                        reasons.push(`Active conversation: ${post.repliesCount} replies`);
                    }
                    if (ageHours <= 6) {
                        reasons.push('Posted recently');
                    } else if (ageHours <= 24) {
                        reasons.push('Posted today');
                    }
                    if (reasons.length === 1) {
                        reasons.push('New post');
                    }

                    return {
                        ...post,
                        feedMeta: {
                            score: Number(score.toFixed(3)),
                            reasons,
                            engagement: {
                                likes: post.likesCount || 0,
                                reposts: post.repostsCount || 0,
                                replies: post.repliesCount || 0,
                            },
                        },
                    };
                })
                .sort((a: any, b: any) => {
                    if (b.feedMeta.score !== a.feedMeta.score) {
                        return b.feedMeta.score - a.feedMeta.score;
                    }
                    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
                })
                .slice(0, limit);

            console.log('[Curated Feed] After ranking:', {
                swarmPostsCount: swarmPosts.length,
                afterMuteFilter: swarmPosts.filter((post: any) => !mutedIds.has(post.author.id) && !blockedIds.has(post.author.id)).length,
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
                let whereCondition = buildWhere(baseFilter, inArray(posts.userId, allowedUserIds));

                if (cursor) {
                    const cursorPost = await db.query.posts.findFirst({
                        where: eq(posts.id, cursor),
                    });
                    if (cursorPost) {
                        whereCondition = buildWhere(baseFilter, inArray(posts.userId, allowedUserIds), lt(posts.createdAt, cursorPost.createdAt));
                    }
                }

                // Get local posts from people the user follows + their own posts
                const localPosts = await db.query.posts.findMany({
                    where: whereCondition,
                    with: {
                        author: true,
                        bot: true,
                        media: true,
                        replyTo: {
                            with: { author: true, media: true },
                        },
                    },
                    orderBy: [desc(posts.createdAt)],
                    limit: cursor ? limit : limit * 2, // Get more on first load to account for mixing with remote
                });

                // Get handles of remote users we follow
                const followedRemoteUsers = await db.query.remoteFollows.findMany({
                    where: eq(remoteFollows.followerId, user.id),
                });

                // Fetch posts LIVE from followed remote users (in parallel, with timeout)
                let liveRemotePosts: any[] = [];
                if (followedRemoteUsers.length > 0) {
                    const { fetchSwarmUserProfile, isSwarmNode } = await import('@/lib/swarm/interactions');

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
                                fetchSwarmUserProfile(handle, domain, limit),
                                5000 // 5s timeout per node
                            );
                            if (!profileData?.posts) return [];

                            return profileData.posts.map(post => ({
                                id: `swarm:${domain}:${post.id}`,
                                content: post.content,
                                createdAt: new Date(post.createdAt),
                                likesCount: post.likesCount || 0,
                                repostsCount: post.repostsCount || 0,
                                repliesCount: post.repliesCount || 0,
                                isRemote: true,
                                isNsfw: post.isNsfw,
                                linkPreviewUrl: post.linkPreviewUrl,
                                linkPreviewTitle: post.linkPreviewTitle,
                                linkPreviewDescription: post.linkPreviewDescription,
                                linkPreviewImage: post.linkPreviewImage,
                                author: {
                                    id: `swarm:${domain}:${handle}`,
                                    handle: follow.targetHandle,
                                    displayName: follow.displayName || profileData.profile?.displayName || handle,
                                    avatarUrl: follow.avatarUrl || profileData.profile?.avatarUrl,
                                    isRemote: true,
                                    isBot: profileData.profile?.isBot,
                                },
                                media: post.media?.map((m: any, idx: number) => ({
                                    id: `swarm:${domain}:${post.id}:media:${idx}`,
                                    url: m.url,
                                    altText: m.altText || null,
                                })) || [],
                                replyTo: null,
                            }));
                        } catch (error) {
                            console.error(`[Home] Error fetching posts from ${follow.targetHandle}:`, error);
                            return [];
                        }
                    });

                    const results = await Promise.all(fetchPromises);
                    liveRemotePosts = results.flat();
                }

                // Merge and sort by date
                const allPosts = [...localPosts, ...liveRemotePosts]
                    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                    .slice(0, limit);

                feedPosts = allPosts as any;
            } catch {
                // Not authenticated, return public timeline
                feedPosts = await db.query.posts.findMany({
                    where: baseFilter,
                    with: {
                        author: true,
                        bot: true,
                        media: true,
                        replyTo: {
                            with: { author: true, media: true },
                        },
                    },
                    orderBy: [desc(posts.createdAt)],
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
                const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:3000';

                // Separate local and swarm posts
                const localPostIds: string[] = [];
                const swarmPosts: Array<{ id: string; domain: string; originalId: string }> = [];

                for (const p of feedPosts as Array<{ id: string }>) {
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
                    const viewerLikes = await db.query.likes.findMany({
                        where: and(
                            eq(likes.userId, viewer.id),
                            inArray(likes.postId, localPostIds)
                        ),
                    });
                    viewerLikes.forEach(l => likedPostIds.add(l.postId));

                    const viewerReposts = await db.query.posts.findMany({
                        where: and(
                            eq(posts.userId, viewer.id),
                            inArray(posts.repostOfId, localPostIds),
                            eq(posts.isRemoved, false)
                        ),
                    });
                    viewerReposts.forEach(r => { if (r.repostOfId) repostedPostIds.add(r.repostOfId); });
                }

                // Check swarm likes in real-time (query origin nodes)
                if (swarmPosts.length > 0) {
                    const checkPromises = swarmPosts.map(async (sp) => {
                        try {
                            const protocol = sp.domain.includes('localhost') ? 'http' : 'https';
                            const url = `${protocol}://${sp.domain}/api/swarm/posts/${sp.originalId}/likes?checkHandle=${viewer.handle}&checkDomain=${nodeDomain}`;

                            const res = await fetch(url, {
                                headers: { 'Accept': 'application/json' },
                                signal: AbortSignal.timeout(3000),
                            });

                            if (res.ok) {
                                const data = await res.json();
                                if (data.isLiked) {
                                    likedPostIds.add(sp.id);
                                }
                            }
                        } catch (err) {
                            // Timeout or error - just skip
                        }
                    });

                    await Promise.all(checkPromises);
                }

                feedPosts = feedPosts.map((p: { id: string }) => ({
                    ...p,
                    isLiked: likedPostIds.has(p.id),
                    isReposted: repostedPostIds.has(p.id),
                })) as any;
            }
        } catch (error) {
            console.error('Error populating interaction flags:', error);
        }

        return NextResponse.json({
            posts: feedPosts || [],
            meta: type === 'curated' ? {
                algorithm: 'curated-v1',
                windowHours: CURATION_WINDOW_HOURS,
                seedLimit: Math.min(limit * CURATION_SEED_MULTIPLIER, CURATION_SEED_CAP),
                weights: {
                    engagement: 1.4,
                    recency: 1.1,
                    followBoost: 0.9,
                    selfBoost: 0.5,
                },
            } : undefined,
            nextCursor: (feedPosts?.length === limit) ? feedPosts[feedPosts.length - 1]?.id : null,
        });
    } catch (error) {
        console.error('Get feed error details:', error);
        return NextResponse.json(
            { error: 'Failed to get feed' },
            { status: 500 }
        );
    }
}
