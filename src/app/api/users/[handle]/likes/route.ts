import { NextResponse } from 'next/server';
import { db, likes, posts, users } from '@/db';
import { eq, desc, and, inArray } from 'drizzle-orm';

type RouteContext = { params: Promise<{ handle: string }> };

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

        // Filter out any likes where the post was removed and format response
        let likedPosts = userLikes
            .filter(like => like.post && !like.post.isRemoved)
            .map(like => like.post);

        // Populate isLiked and isReposted for authenticated users
        try {
            const { getSession } = await import('@/lib/auth');
            const session = await getSession();

            if (session?.user && likedPosts.length > 0) {
                const viewer = session.user;
                const postIds = likedPosts.map(p => p!.id).filter(Boolean);

                if (postIds.length > 0) {
                    const viewerLikes = await db.query.likes.findMany({
                        where: and(
                            eq(likes.userId, viewer.id),
                            inArray(likes.postId, postIds)
                        ),
                    });
                    const likedPostIds = new Set(viewerLikes.map(l => l.postId));

                    const viewerReposts = await db.query.posts.findMany({
                        where: and(
                            eq(posts.userId, viewer.id),
                            inArray(posts.repostOfId, postIds),
                            eq(posts.isRemoved, false)
                        ),
                    });
                    const repostedPostIds = new Set(viewerReposts.map(r => r.repostOfId));

                    likedPosts = likedPosts.map(p => ({
                        ...p!,
                        isLiked: likedPostIds.has(p!.id),
                        isReposted: repostedPostIds.has(p!.id),
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
