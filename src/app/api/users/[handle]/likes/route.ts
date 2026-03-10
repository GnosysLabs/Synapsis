import { NextResponse } from 'next/server';
import { db, likes, posts, users, userSwarmLikes } from '@/db';
import { eq, desc, and, inArray } from 'drizzle-orm';
import { discoverNode } from '@/lib/swarm/discovery';
import { isSwarmNode } from '@/lib/swarm/interactions';
import { getRemoteBaseUrl, mapRemoteProfilePost, parseRemoteHandle } from '@/lib/swarm/remote-profile-posts';
import { getViewerSwarmRepostedPostIds } from '@/lib/swarm/reposts';
import { parseLinkPreviewMediaJson } from '@/lib/media/linkPreview';

type RouteContext = { params: Promise<{ handle: string }> };

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
        const cleanHandle = handle.toLowerCase().replace(/^@/, '');
        const { searchParams } = new URL(request.url);
        const limit = Math.min(parseInt(searchParams.get('limit') || '25'), 50);
        const remote = parseRemoteHandle(handle);

        const fetchRemoteLikesRoute = async () => {
            if (!remote) {
                return NextResponse.json({ posts: [], nextCursor: null });
            }

            const baseUrl = getRemoteBaseUrl(remote.domain);
            const res = await fetch(`${baseUrl}/api/users/${remote.handle}/likes?limit=${limit}`, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(10000),
            });

            if (!res.ok) {
                return NextResponse.json({ posts: [], nextCursor: null });
            }

            const data = await res.json();
            const { getSession } = await import('@/lib/auth');
            const session = await getSession();
            const viewer = session?.user;
            const mappedPosts = (data.posts || []).map((post: any) => mapRemoteProfilePost(post, remote.domain));
            const repostedIds = viewer
                ? await getViewerSwarmRepostedPostIds(
                    mappedPosts.map((post: any) => ({
                        id: post.id,
                        nodeDomain: remote.domain,
                        originalPostId: post.originalPostId || post.id.split(':').pop(),
                    })),
                    viewer.id
                )
                : new Set<string>();
            return NextResponse.json({
                posts: mappedPosts.map((post: any) => ({
                    ...post,
                    isReposted: repostedIds.has(post.id),
                })),
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
            where: eq(users.handle, cleanHandle),
        });
        const isRemotePlaceholder = user && cleanHandle.includes('@');

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

        // Don't show likes for bot accounts
        if (user.isBot) {
            return NextResponse.json({ posts: [] });
        }

        // Get user's liked posts
        const userLikes = await db.query.likes.findMany({
            where: eq(likes.userId, user.id),
            with: {
                post: {
                    with: likedPostRelations,
                },
            },
            orderBy: [desc(likes.createdAt)],
            limit,
        });

        const localLikedPosts = userLikes
            .filter(like => like.post && !like.post.isRemoved)
            .map(like => like.post);

        const swarmLikedRows = await db.query.userSwarmLikes.findMany({
            where: eq(userSwarmLikes.userId, user.id),
            orderBy: [desc(userSwarmLikes.likedAt)],
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

        let likedPosts: any[] = [
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
                    .filter((post: any) => !post.isSwarm)
                    .map((post: any) => post.id)
                    .filter(Boolean);
                const swarmTargets = likedPosts
                    .filter((post: any) => post.isSwarm)
                    .map((post: any) => ({
                        id: post.id,
                        nodeDomain: post.nodeDomain,
                        originalPostId: post.originalPostId,
                    }))
                    .filter((post: any) => post.nodeDomain && post.originalPostId);
                const swarmRepostedIds = swarmTargets.length > 0
                    ? await getViewerSwarmRepostedPostIds(swarmTargets as any, viewer.id)
                    : new Set<string>();

                if (localPostIds.length > 0) {
                    const viewerLikes = await db.query.likes.findMany({
                        where: and(
                            eq(likes.userId, viewer.id),
                            inArray(likes.postId, localPostIds)
                        ),
                    });
                    const likedPostIds = new Set(viewerLikes.map(l => l.postId));

                    const viewerReposts = await db.query.posts.findMany({
                        where: and(
                            eq(posts.userId, viewer.id),
                            inArray(posts.repostOfId, localPostIds),
                            eq(posts.isRemoved, false)
                        ),
                    });
                    const repostedPostIds = new Set(viewerReposts.map(r => r.repostOfId));

                    likedPosts = likedPosts.map(p => ({
                        ...p!,
                        isLiked: p!.isSwarm ? isOwnLikesView : likedPostIds.has(p!.id),
                        isReposted: p!.isSwarm ? swarmRepostedIds.has(p!.id) : repostedPostIds.has(p!.id),
                    })) as any;
                } else {
                    likedPosts = likedPosts.map(p => ({
                        ...p!,
                        isLiked: p!.isSwarm ? isOwnLikesView : p!.isLiked,
                        isReposted: p!.isSwarm ? swarmRepostedIds.has(p!.id) : p!.isReposted,
                    })) as any;
                }
            }
        } catch (error) {
            console.error('Error populating interaction flags:', error);
        }

        return NextResponse.json({
            posts: likedPosts,
            nextCursor: likedPosts.length === limit ? likedPosts[likedPosts.length - 1]?.id : null,
        });
    } catch (error) {
        console.error('Get user likes error:', error);
        return NextResponse.json({ error: 'Failed to get likes' }, { status: 500 });
    }
}
