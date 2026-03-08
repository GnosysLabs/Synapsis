import { NextResponse } from 'next/server';
import { db, likes, posts, users, userSwarmLikes } from '@/db';
import { eq, desc, and, inArray } from 'drizzle-orm';

type RouteContext = { params: Promise<{ handle: string }> };

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

        // Find the user
        const user = await db.query.users.findFirst({
            where: eq(users.handle, cleanHandle),
        });

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
                    with: {
                        author: true,
                        media: true,
                        bot: true,
                    },
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
                        isReposted: repostedPostIds.has(p!.id),
                    })) as any;
                } else {
                    likedPosts = likedPosts.map(p => ({
                        ...p!,
                        isLiked: p!.isSwarm ? isOwnLikesView : p!.isLiked,
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
