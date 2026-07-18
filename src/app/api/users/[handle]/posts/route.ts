import { NextResponse } from 'next/server';
import { db, users, userSwarmReposts } from '@/db';
import { fetchSwarmUserProfile, isSwarmNode } from '@/lib/swarm/interactions';
import { discoverNode } from '@/lib/swarm/discovery';
import { getViewerSwarmLikedPostIds } from '@/lib/swarm/likes';
import { mapRemoteProfilePost, type RemoteProfilePost } from '@/lib/swarm/remote-profile-posts';
import { resolveUserHandle } from '@/lib/swarm/user-handle';
import { parseLinkPreviewMediaJson } from '@/lib/media/linkPreview';
import { attachRemoteRepostSummaries } from '@/lib/posts/remote-reposts';
import {
    canCurrentViewerAccessSensitiveRemoteProfile,
    getCurrentViewerSensitiveProfileAccess,
    SENSITIVE_PROFILE_MESSAGE,
    SENSITIVE_REMOTE_PROFILE_MESSAGE,
} from '@/lib/nsfw/remote-profile-access';
import { getSensitiveContentViewerAccess } from '@/lib/nsfw/viewer-access';
import { redactSensitivePostForViewer } from '@/lib/nsfw/content-visibility';
import { parseBoundedInteger } from '@/lib/http/query';

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
    repostedBy?: Array<{
        id: string;
        handle: string;
        displayName: string;
        avatarUrl?: string | null;
        nodeDomain?: string | null;
        isNsfw?: boolean;
    }>;
    repostedByCount?: number;
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
            media: parseMediaJson(row.mediaJson),
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
            where: { id: cursor.replace('swarm-repost:', '') },
        });
        return repostRow?.repostedAt ?? null;
    }

    const cursorPost = await db.query.posts.findFirst({
        where: { id: cursor },
    });
    return cursorPost?.createdAt ?? null;
}

async function populateViewerLikeState(
    remotePosts: FeedPostWithChildren[]
) {
    if (!remotePosts.length) {
        return remotePosts;
    }

    try {
        const { getSession } = await import('@/lib/auth');
        const session = await getSession();
        const viewer = session?.user;
        const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';

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
        const resolvedHandle = resolveUserHandle(handle);
        const cleanHandle = resolvedHandle.canonicalHandle;
        const { searchParams } = new URL(request.url);
        const limit = parseBoundedInteger(searchParams.get('limit'), {
            defaultValue: 25,
            min: 1,
            max: 50,
        });
        const cursor = searchParams.get('cursor');
        const viewerAccess = await getSensitiveContentViewerAccess();
        const serializePosts = (postsToSerialize: FeedPostWithChildren[]) => (
            postsToSerialize.map((post) => redactSensitivePostForViewer(
                post as unknown as Record<string, unknown>,
                {
                    canViewSensitive: viewerAccess.canViewSensitive,
                    localNodeDomain: process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
                    localNodeIsNsfw: viewerAccess.localNodeIsNsfw,
                },
            ))
        );

        const remote = resolvedHandle.remote;
        const fetchRemotePostsRoute = async () => {
            if (!remote) {
                return NextResponse.json({ posts: [], nextCursor: null });
            }

            const profileData = await fetchSwarmUserProfile(remote.handle, remote.domain, limit);
            if (!profileData) {
                return NextResponse.json({ posts: [], nextCursor: null });
            }

            if (!await canCurrentViewerAccessSensitiveRemoteProfile({
                accountIsNsfw: profileData.profile.isNsfw,
                nodeIsNsfw: profileData.profile.nodeIsNsfw,
            })) {
                return NextResponse.json(
                    { posts: [], nextCursor: null, restricted: true, error: SENSITIVE_REMOTE_PROFILE_MESSAGE },
                    { status: 403 },
                );
            }

            const mappedPosts = profileData.posts.map((post) => (
                mapRemoteProfilePost(post as unknown as RemoteProfilePost, remote.domain) as unknown as FeedPostWithChildren
            ));
            return NextResponse.json({
                posts: serializePosts(await populateViewerLikeState(mappedPosts)),
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

            return await fetchRemotePostsRoute();
        }

        // Find the user
        const user = await db.query.users.findFirst({
            where: { handle: cleanHandle },
        });
        const isRemotePlaceholder = Boolean(user && remote);

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

        const profileAccess = await getCurrentViewerSensitiveProfileAccess({
            accountIsNsfw: user.isNsfw,
        });
        if (!profileAccess.allowed) {
            return NextResponse.json(
                { posts: [], nextCursor: null, restricted: true, error: SENSITIVE_PROFILE_MESSAGE },
                { status: 403 },
            );
        }

        // Get user's posts with cursor-based pagination
        const cursorDate = await getMixedProfileCursorDate(cursor);
        const whereConditions = {
            userId: user.id,
            isRemoved: false,
            replyToId: { isNull: true as const },
            swarmReplyToId: { isNull: true as const },
            ...(cursorDate ? { createdAt: { lt: cursorDate } } : {}),
        };

        const localPosts = await db.query.posts.findMany({
            where: whereConditions,
            with: userPostRelations,
            orderBy: (posts, { desc }) => [desc(posts.createdAt)],
            limit: cursor ? limit : limit * 2,
        });
        const remoteRepostRows = localPosts.length > 0
            ? await db.query.remoteReposts.findMany({
                where: { postId: { in: localPosts.map((post) => post.id) } },
                orderBy: (remoteReposts, { desc }) => [desc(remoteReposts.createdAt)],
            })
            : [];
        const summarizedLocalPosts = attachRemoteRepostSummaries(localPosts, remoteRepostRows);

        const swarmRepostWhere = {
            userId: user.id,
            ...(cursorDate ? { repostedAt: { lt: cursorDate } } : {}),
        };
        const swarmRepostRows = await db.query.userSwarmReposts.findMany({
            where: swarmRepostWhere,
            orderBy: (userSwarmReposts, { desc }) => [desc(userSwarmReposts.repostedAt)],
            limit: cursor ? limit : limit * 2,
        });
        let userPosts: FeedPostWithChildren[] = [
            ...summarizedLocalPosts,
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
                        where: { AND: [{ userId: viewer.id }, { postId: { in: localPostIds } }] },
                    });
                    viewerLikes.forEach((like) => likedPostIds.add(like.postId));

                    const viewerReposts = await db.query.posts.findMany({
                        where: { AND: [{ userId: viewer.id }, { repostOfId: { in: localPostIds } }, { isRemoved: false }] },
                    });
                    viewerReposts.forEach((repost) => {
                        if (repost.repostOfId) {
                            repostedPostIds.add(repost.repostOfId);
                        }
                    });
                }

                if (swarmTargets.length > 0) {
                    const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';
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
                );
            }
        } catch (error) {
            console.error('Error populating interaction flags:', error);
        }

        return NextResponse.json({
            posts: serializePosts(userPosts),
            nextCursor: userPosts.length === limit ? userPosts[userPosts.length - 1]?.id : null,
        });
    } catch (error) {
        console.error('Get user posts error:', error);
        return NextResponse.json({ error: 'Failed to get posts' }, { status: 500 });
    }
}
