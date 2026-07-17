import { NextResponse } from 'next/server';
import { db } from '@/db';
import { discoverNode } from '@/lib/swarm/discovery';
import { fetchSwarmUserProfile, isSwarmNode } from '@/lib/swarm/interactions';
import { getRemoteBaseUrl, mapRemoteProfilePost, type RemoteProfilePost } from '@/lib/swarm/remote-profile-posts';
import { resolveUserHandle } from '@/lib/swarm/user-handle';
import { getViewerSwarmRepostedPostIds } from '@/lib/swarm/reposts';
import { parseLinkPreviewMediaJson } from '@/lib/media/linkPreview';
import {
    canCurrentViewerAccessSensitiveRemoteProfile,
    getCurrentViewerSensitiveProfileAccess,
    SENSITIVE_PROFILE_MESSAGE,
    SENSITIVE_REMOTE_PROFILE_MESSAGE,
} from '@/lib/nsfw/remote-profile-access';
import { getSensitiveContentViewerAccess } from '@/lib/nsfw/viewer-access';
import { redactSensitivePostForViewer } from '@/lib/nsfw/content-visibility';
import { signedFederationRead } from '@/lib/swarm/signed-read';

type RouteContext = { params: Promise<{ handle: string }> };
type LikedPost = {
    id: string;
    createdAt: string | Date;
    isSwarm?: boolean;
    nodeDomain?: string | null;
    originalPostId?: string;
    isLiked?: boolean;
    isReposted?: boolean;
    [key: string]: unknown;
};

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

const likedPostRelations = {
    ...embeddedPostRelations,
    repostOf: {
        with: embeddedPostRelations,
    },
} as const;

const parseMediaJson = (mediaJson: string | null) => {
    if (!mediaJson) {
        return [];
    }

    try {
        return JSON.parse(mediaJson);
    } catch {
        return [];
    }
};

export async function GET(request: Request, context: RouteContext) {
    try {
        const { handle } = await context.params;
        const resolvedHandle = resolveUserHandle(handle);
        const cleanHandle = resolvedHandle.canonicalHandle;
        const { searchParams } = new URL(request.url);
        const limit = Math.min(parseInt(searchParams.get('limit') || '25'), 50);
        const remote = resolvedHandle.remote;
        const viewerAccess = await getSensitiveContentViewerAccess();
        const serializePosts = (postsToSerialize: LikedPost[]) => (
            postsToSerialize.map((post) => redactSensitivePostForViewer(
                post as unknown as Record<string, unknown>,
                {
                    canViewSensitive: viewerAccess.canViewSensitive,
                    localNodeDomain: process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
                    localNodeIsNsfw: viewerAccess.localNodeIsNsfw,
                },
            ))
        );

        const fetchRemoteLikesRoute = async () => {
            if (!remote) {
                return NextResponse.json({ posts: [], nextCursor: null });
            }

            const profileData = await fetchSwarmUserProfile(remote.handle, remote.domain, 0);
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

            const baseUrl = getRemoteBaseUrl(remote.domain);
            const res = await signedFederationRead(`${baseUrl}/api/users/${encodeURIComponent(remote.handle)}/likes?limit=${limit}`, {
                headers: { Accept: 'application/json' },
                timeoutMs: 8_000,
                maxResponseBytes: 1024 * 1024,
            });

            if (res.status < 200 || res.status >= 300) {
                return NextResponse.json({ posts: [], nextCursor: null });
            }

            const data = res.json() as { posts?: RemoteProfilePost[] };
            const { getSession } = await import('@/lib/auth');
            const session = await getSession();
            const viewer = session?.user;
            const mappedPosts = (data.posts || []).map((post) => mapRemoteProfilePost(post, remote.domain));
            const repostedIds = viewer
                ? await getViewerSwarmRepostedPostIds(
                    mappedPosts.map((post) => ({
                        id: post.id,
                        nodeDomain: remote.domain,
                        originalPostId: post.originalPostId || post.id.split(':').pop() || post.id,
                    })),
                    viewer.id
                )
                : new Set<string>();
            return NextResponse.json({
                posts: serializePosts(mappedPosts.map((post) => ({
                    ...post,
                    isReposted: repostedIds.has(post.id),
                })) as LikedPost[]),
                nextCursor: null,
            });
        };

        if (!db) {
            if (!remote) {
                return NextResponse.json({ posts: [], nextCursor: null });
            }

            let swarm = await isSwarmNode(remote.domain);
            if (!swarm) {
                const discovery = await discoverNode(remote.domain);
                swarm = discovery.success;
            }

            if (!swarm) {
                return NextResponse.json({ posts: [], nextCursor: null });
            }

            return await fetchRemoteLikesRoute();
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

            let swarm = await isSwarmNode(remote.domain);
            if (!swarm) {
                const discovery = await discoverNode(remote.domain);
                swarm = discovery.success;
            }

            if (!swarm) {
                return NextResponse.json({ posts: [], nextCursor: null });
            }

            return await fetchRemoteLikesRoute();
        }

        if (!user) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
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

        // Get user's liked posts
        const userLikes = await db.query.likes.findMany({
            where: { userId: user.id },
            with: {
                post: {
                    with: likedPostRelations,
                },
            },
            orderBy: (likes, { desc }) => [desc(likes.createdAt)],
            limit,
        });

        const localLikedPosts = userLikes
            .filter(like => like.post && !like.post.isRemoved)
            .map(like => like.post);

        const swarmLikedRows = await db.query.userSwarmLikes.findMany({
            where: { userId: user.id },
            orderBy: (userSwarmLikes, { desc }) => [desc(userSwarmLikes.likedAt)],
            limit,
        });

        const swarmLikedPosts = swarmLikedRows.map((like) => ({
            id: `swarm:${like.nodeDomain}:${like.originalPostId}`,
            originalPostId: like.originalPostId,
            content: like.content,
            createdAt: like.postCreatedAt.toISOString(),
            likesCount: like.likesCount,
            repostsCount: like.repostsCount,
            repliesCount: like.repliesCount,
            author: {
                id: `swarm:${like.nodeDomain}:${like.authorHandle}`,
                handle: `${like.authorHandle}@${like.nodeDomain}`,
                displayName: like.authorDisplayName || like.authorHandle,
                avatarUrl: like.authorAvatarUrl,
            },
            media: parseMediaJson(like.mediaJson),
            linkPreviewUrl: like.linkPreviewUrl,
            linkPreviewTitle: like.linkPreviewTitle,
            linkPreviewDescription: like.linkPreviewDescription,
            linkPreviewImage: like.linkPreviewImage,
            linkPreviewType: like.linkPreviewType,
            linkPreviewVideoUrl: like.linkPreviewVideoUrl,
            linkPreviewMedia: parseLinkPreviewMediaJson(like.linkPreviewMediaJson) || null,
            isSwarm: true,
            nodeDomain: like.nodeDomain,
            likedAt: like.likedAt.toISOString(),
            isLiked: false,
        }));

        let likedPosts: LikedPost[] = [
            ...localLikedPosts.map((post) => ({
                ...post,
                likedAt: userLikes.find((like) => like.post?.id === post.id)?.createdAt?.toISOString() || post.createdAt.toISOString(),
            })),
            ...swarmLikedPosts,
        ]
            .sort((a, b) => new Date(b.likedAt).getTime() - new Date(a.likedAt).getTime())
            .slice(0, limit);

        // Populate isLiked and isReposted for authenticated users
        try {
            const { getSession } = await import('@/lib/auth');
            const session = await getSession();

            if (session?.user && likedPosts.length > 0) {
                const viewer = session.user;
                const isOwnLikesView = viewer.id === user.id;
                const localPostIds = likedPosts
                    .filter((post) => !post.isSwarm)
                    .map((post) => post.id)
                    .filter(Boolean);
                const swarmTargets = likedPosts
                    .filter((post) => post.isSwarm)
                    .map((post) => ({
                        id: post.id,
                        nodeDomain: post.nodeDomain,
                        originalPostId: post.originalPostId,
                    }))
                    .filter((post): post is { id: string; nodeDomain: string; originalPostId: string } => Boolean(post.nodeDomain && post.originalPostId));
                const swarmRepostedIds = swarmTargets.length > 0
                    ? await getViewerSwarmRepostedPostIds(swarmTargets, viewer.id)
                    : new Set<string>();

                if (localPostIds.length > 0) {
                    const viewerLikes = await db.query.likes.findMany({
                        where: { AND: [{ userId: viewer.id }, { postId: { in: localPostIds } }] },
                    });
                    const likedPostIds = new Set(viewerLikes.map(l => l.postId));

                    const viewerReposts = await db.query.posts.findMany({
                        where: { AND: [{ userId: viewer.id }, { repostOfId: { in: localPostIds } }, { isRemoved: false }] },
                    });
                    const repostedPostIds = new Set(viewerReposts.map(r => r.repostOfId));

                    likedPosts = likedPosts.map(p => ({
                        ...p!,
                        isLiked: p!.isSwarm ? isOwnLikesView : likedPostIds.has(p!.id),
                        isReposted: p!.isSwarm ? swarmRepostedIds.has(p!.id) : repostedPostIds.has(p!.id),
                    }));
                } else {
                    likedPosts = likedPosts.map(p => ({
                        ...p!,
                        isLiked: p!.isSwarm ? isOwnLikesView : p!.isLiked,
                        isReposted: p!.isSwarm ? swarmRepostedIds.has(p!.id) : p!.isReposted,
                    }));
                }
            }
        } catch (error) {
            console.error('Error populating interaction flags:', error);
        }

        return NextResponse.json({
            posts: serializePosts(likedPosts),
            nextCursor: likedPosts.length === limit ? likedPosts[likedPosts.length - 1]?.id : null,
        });
    } catch (error) {
        console.error('Get user likes error:', error);
        return NextResponse.json({ error: 'Failed to get likes' }, { status: 500 });
    }
}
