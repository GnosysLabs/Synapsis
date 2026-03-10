import { NextResponse } from 'next/server';
import { db, posts, users, likes, userSwarmReposts } from '@/db';
import { eq, desc, and, inArray, lt, sql, isNull } from 'drizzle-orm';
import { fetchSwarmUserProfile, isSwarmNode } from '@/lib/swarm/interactions';
import { discoverNode } from '@/lib/swarm/discovery';
import { getViewerSwarmLikedPostIds } from '@/lib/swarm/likes';
import { getRemoteBaseUrl, mapRemoteProfilePost, parseRemoteHandle } from '@/lib/swarm/remote-profile-posts';
import { parseLinkPreviewMediaJson } from '@/lib/media/linkPreview';

const embeddedPostRelations = {
    author: true,
    bot: true,
    media: true,
    replyTo: {
        with: {
            author: true,
            bot: true,
            media: true,
        },
    },
} as const;

const userPostRelations = {
    ...embeddedPostRelations,
    repostOf: {
        with: embeddedPostRelations,
    },
} as const;

type RouteContext = { params: Promise<{ handle: string }> };

type FeedPostWithChildren = {
    id: string;
    createdAt?: string | Date;
    repostOf?: FeedPostWithChildren | null;
    replyTo?: FeedPostWithChildren | null;
    isLiked?: boolean;
    isReposted?: boolean;
    nodeDomain?: string | null;
    originalPostId?: string | null;
};

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

function mapUserSwarmRepostToFeedPost(
    row: typeof userSwarmReposts.$inferSelect,
    author: Pick<typeof users.$inferSelect, 'id' | 'handle' | 'displayName' | 'avatarUrl' | 'isBot'>
): FeedPostWithChildren {
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
            isBot: author.isBot,
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
            author: {
                id: `swarm:${row.nodeDomain}:${row.authorHandle}`,
                handle: remoteAuthorHandle,
                displayName: row.authorDisplayName || row.authorHandle,
                avatarUrl: row.authorAvatarUrl,
                isRemote: true,
                nodeDomain: row.nodeDomain,
            },
            media: parseMediaJson(row.mediaJson),
            linkPreviewUrl: row.linkPreviewUrl,
            linkPreviewTitle: row.linkPreviewTitle,
            linkPreviewDescription: row.linkPreviewDescription,
            linkPreviewImage: row.linkPreviewImage,
            linkPreviewType: row.linkPreviewType,
            linkPreviewVideoUrl: row.linkPreviewVideoUrl,
            linkPreviewMedia: parseLinkPreviewMediaJson(row.linkPreviewMediaJson) || null,
        },
    } as any;
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
    repostedIds: Set<string>
): FeedPostWithChildren[] {
    return posts.map((post) => ({
        ...post,
        isLiked: likedIds.has(post.id),
        isReposted: repostedIds.has(post.id),
        repostOf: post.repostOf ? applyInteractionFlags([post.repostOf], likedIds, repostedIds)[0] : post.repostOf,
        replyTo: post.replyTo ? applyInteractionFlags([post.replyTo], likedIds, repostedIds)[0] : post.replyTo,
    }));
}

function getPostTimestamp(post: { createdAt?: string | Date }) {
    if (!post.createdAt) {
        return 0;
    }

    return new Date(post.createdAt).getTime();
}

async function getMixedProfileCursorDate(cursor: string | null) {
    if (!cursor) {
        return null;
    }

    if (cursor.startsWith('swarm-repost:')) {
        const repostRow = await db.query.userSwarmReposts.findFirst({
            where: eq(userSwarmReposts.id, cursor.replace('swarm-repost:', '')),
        });
        return repostRow?.repostedAt ?? null;
    }

    const cursorPost = await db.query.posts.findFirst({
        where: eq(posts.id, cursor),
    });
    return cursorPost?.createdAt ?? null;
}

async function populateViewerLikeState(
    remotePosts: any[]
) {
    if (!remotePosts.length) {
        return remotePosts;
    }

    try {
        const { getSession } = await import('@/lib/auth');
        const session = await getSession();
        const viewer = session?.user;
        const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:3000';

        if (!viewer) {
            return remotePosts;
        }

        const { getViewerSwarmRepostedPostIds } = await import('@/lib/swarm/reposts');

        const allRemotePosts = collectNestedPosts(remotePosts as FeedPostWithChildren[]);
        const swarmTargets = allRemotePosts
            .filter((post) => post.id.startsWith('swarm:') && post.originalPostId && post.nodeDomain)
            .map((post) => ({
                id: post.id,
                nodeDomain: post.nodeDomain!,
                originalPostId: post.originalPostId!,
            }));

        const likedIds = await getViewerSwarmLikedPostIds(
            swarmTargets,
            viewer.handle,
            nodeDomain
        );
        const repostedIds = await getViewerSwarmRepostedPostIds(
            swarmTargets,
            viewer.id
        );

        return applyInteractionFlags(
            remotePosts as FeedPostWithChildren[],
            likedIds,
            repostedIds
        );
    } catch {
        return remotePosts;
    }
}

export async function GET(request: Request, context: RouteContext) {
    try {
        const { handle } = await context.params;
        const cleanHandle = handle.toLowerCase().replace(/^@/, '');
        const { searchParams } = new URL(request.url);
        const limit = Math.min(parseInt(searchParams.get('limit') || '25'), 50);
        const cursor = searchParams.get('cursor');

        const remote = parseRemoteHandle(handle);
        const fetchRemotePostsRoute = async () => {
            if (!remote) {
                return NextResponse.json({ posts: [], nextCursor: null });
            }

            const baseUrl = getRemoteBaseUrl(remote.domain);
            const res = await fetch(
                `${baseUrl}/api/users/${remote.handle}/posts?limit=${limit}`,
                {
                    headers: { Accept: 'application/json' },
                    signal: AbortSignal.timeout(10000),
                }
            );

            if (!res.ok) {
                return NextResponse.json({ posts: [], nextCursor: null });
            }

            const data = await res.json();
            const mappedPosts = (data.posts || []).map((post: any) => mapRemoteProfilePost(post, remote.domain));
            return NextResponse.json({
                posts: await populateViewerLikeState(mappedPosts),
                nextCursor: null,
            });
        };

        if (!db) {
            if (!remote) {
                return NextResponse.json({ posts: [], nextCursor: null });
            }

            // Only fetch from swarm nodes
            let isSwarm = await isSwarmNode(remote.domain);
            if (!isSwarm) {
                const discovery = await discoverNode(remote.domain);
                isSwarm = discovery.success;
            }

            if (!isSwarm) {
                return NextResponse.json({ posts: [], message: 'Only Synapsis swarm nodes are supported' });
            }

            const profileData = await fetchSwarmUserProfile(remote.handle, remote.domain, limit);
            if (profileData?.posts) {
                const profile = profileData.profile;
                const authorHandle = `${profile.handle}@${remote.domain}`;
                const author = {
                    id: `swarm:${remote.domain}:${profile.handle}`,
                    handle: authorHandle,
                    displayName: profile.displayName || profile.handle,
                    avatarUrl: profile.avatarUrl,
                };

                const remotePosts = profileData.posts.map((post: any) => ({
                    id: post.id,
                    originalPostId: post.id,
                    content: post.content,
                    createdAt: post.createdAt,
                    likesCount: post.likesCount || 0,
                    repostsCount: post.repostsCount || 0,
                    repliesCount: post.repliesCount || 0,
                    author,
                    media: post.media || [],
                    linkPreviewUrl: post.linkPreviewUrl || null,
                    linkPreviewTitle: post.linkPreviewTitle || null,
                    linkPreviewDescription: post.linkPreviewDescription || null,
                    linkPreviewImage: post.linkPreviewImage || null,
                    linkPreviewType: post.linkPreviewType || null,
                    linkPreviewVideoUrl: post.linkPreviewVideoUrl || null,
                    linkPreviewMedia: post.linkPreviewMedia || null,
                    isSwarm: true,
                    nodeDomain: remote.domain,
                }));

                return NextResponse.json({ posts: await populateViewerLikeState(remotePosts), nextCursor: null });
            }

            return NextResponse.json({ posts: [] });
        }

        // Find the user
        const user = await db.query.users.findFirst({
            where: eq(users.handle, cleanHandle),
        });
        const isRemotePlaceholder = user && cleanHandle.includes('@');

        if (!user || isRemotePlaceholder) {
            if (!remote) {
                return NextResponse.json({ error: 'User not found' }, { status: 404 });
            }

            // Only fetch from swarm nodes
            let isSwarm = await isSwarmNode(remote.domain);
            if (!isSwarm) {
                const discovery = await discoverNode(remote.domain);
                isSwarm = discovery.success;
            }

            if (!isSwarm) {
                return NextResponse.json({ posts: [], message: 'Only Synapsis swarm nodes are supported' });
            }

            return await fetchRemotePostsRoute();
        }

        if (user.isSuspended) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        // Get user's posts with cursor-based pagination
        const cursorDate = await getMixedProfileCursorDate(cursor);
        let whereConditions = and(
            eq(posts.userId, user.id),
            eq(posts.isRemoved, false),
            isNull(posts.replyToId),
            isNull(posts.swarmReplyToId)
        );

        if (cursorDate) {
            whereConditions = and(
                eq(posts.userId, user.id),
                eq(posts.isRemoved, false),
                isNull(posts.replyToId),
                isNull(posts.swarmReplyToId),
                lt(posts.createdAt, cursorDate)
            );
        }

        const localPosts = await db.query.posts.findMany({
            where: whereConditions,
            with: userPostRelations,
            orderBy: [desc(posts.createdAt)],
            limit: cursor ? limit : limit * 2,
        });

        const swarmRepostWhere = cursorDate
            ? and(
                eq(userSwarmReposts.userId, user.id),
                lt(userSwarmReposts.repostedAt, cursorDate)
            )
            : eq(userSwarmReposts.userId, user.id);
        const swarmRepostRows = await db.query.userSwarmReposts.findMany({
            where: swarmRepostWhere,
            orderBy: [desc(userSwarmReposts.repostedAt)],
            limit: cursor ? limit : limit * 2,
        });
        let userPosts: any[] = [
            ...localPosts,
            ...swarmRepostRows.map((row) => mapUserSwarmRepostToFeedPost(row, user)),
        ]
            .sort((a, b) => getPostTimestamp(b) - getPostTimestamp(a))
            .slice(0, limit);

        // Populate isLiked and isReposted for authenticated users
        try {
            const { getSession } = await import('@/lib/auth');
            const session = await getSession();

            if (session?.user && userPosts.length > 0) {
                const viewer = session.user;
                const allProfilePosts = collectNestedPosts(userPosts as FeedPostWithChildren[]);
                const localPostIds: string[] = [];
                const swarmTargets: Array<{ id: string; nodeDomain: string; originalPostId: string }> = [];

                for (const post of allProfilePosts) {
                    if (post.id.startsWith('swarm:') && post.nodeDomain && post.originalPostId) {
                        swarmTargets.push({
                            id: post.id,
                            nodeDomain: post.nodeDomain,
                            originalPostId: post.originalPostId,
                        });
                    } else if (!post.id.startsWith('swarm-repost:')) {
                        localPostIds.push(post.id);
                    }
                }

                const likedPostIds = new Set<string>();
                const repostedPostIds = new Set<string>();

                if (localPostIds.length > 0) {
                    const viewerLikes = await db.query.likes.findMany({
                        where: and(
                            eq(likes.userId, viewer.id),
                            inArray(likes.postId, localPostIds)
                        ),
                    });
                    viewerLikes.forEach((like) => likedPostIds.add(like.postId));

                    const viewerReposts = await db.query.posts.findMany({
                        where: and(
                            eq(posts.userId, viewer.id),
                            inArray(posts.repostOfId, localPostIds),
                            eq(posts.isRemoved, false)
                        ),
                    });
                    viewerReposts.forEach((repost) => {
                        if (repost.repostOfId) {
                            repostedPostIds.add(repost.repostOfId);
                        }
                    });
                }

                if (swarmTargets.length > 0) {
                    const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:3000';
                    const likedIds = await getViewerSwarmLikedPostIds(
                        swarmTargets.map((post) => ({
                            id: post.id,
                            nodeDomain: post.nodeDomain,
                            originalPostId: post.originalPostId,
                        })),
                        viewer.handle,
                        nodeDomain
                    );
                    likedIds.forEach((id) => likedPostIds.add(id));

                    const { getViewerSwarmRepostedPostIds } = await import('@/lib/swarm/reposts');
                    const repostedIds = await getViewerSwarmRepostedPostIds(swarmTargets, viewer.id);
                    repostedIds.forEach((id) => repostedPostIds.add(id));
                }

                userPosts = applyInteractionFlags(
                    userPosts as FeedPostWithChildren[],
                    likedPostIds,
                    repostedPostIds
                ) as any;
            }
        } catch (error) {
            console.error('Error populating interaction flags:', error);
        }

        return NextResponse.json({
            posts: userPosts,
            nextCursor: userPosts.length === limit ? userPosts[userPosts.length - 1]?.id : null,
        });
    } catch (error) {
        console.error('Get user posts error:', error);
        return NextResponse.json({ error: 'Failed to get posts' }, { status: 500 });
    }
}
