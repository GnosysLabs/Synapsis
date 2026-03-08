import { NextResponse } from 'next/server';
import { db, posts, users, likes } from '@/db';
import { eq, desc, and, inArray, lt } from 'drizzle-orm';
import { fetchSwarmUserProfile, isSwarmNode } from '@/lib/swarm/interactions';

type RouteContext = { params: Promise<{ handle: string }> };

const parseRemoteHandle = (handle: string) => {
    const clean = handle.toLowerCase().replace(/^@/, '');
    const parts = clean.split('@').filter(Boolean);
    if (parts.length === 2) {
        return { handle: parts[0], domain: parts[1] };
    }
    return null;
};

export async function GET(request: Request, context: RouteContext) {
    try {
        const { handle } = await context.params;
        const cleanHandle = handle.toLowerCase().replace(/^@/, '');
        const { searchParams } = new URL(request.url);
        const limit = Math.min(parseInt(searchParams.get('limit') || '25'), 50);
        const cursor = searchParams.get('cursor');

        const remote = parseRemoteHandle(handle);

        if (!db) {
            if (!remote) {
                return NextResponse.json({ posts: [], nextCursor: null });
            }

            // Only fetch from swarm nodes
            const isSwarm = await isSwarmNode(remote.domain);
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
                
                const posts = profileData.posts.map((post: any) => ({
                    id: post.id,
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
                    isSwarm: true,
                    nodeDomain: remote.domain,
                    originalPostId: post.id,
                }));

                return NextResponse.json({ posts, nextCursor: null });
            }

            return NextResponse.json({ posts: [] });
        }

        // Find the user
        const user = await db.query.users.findFirst({
            where: eq(users.handle, cleanHandle),
        });

        if (!user) {
            if (!remote) {
                return NextResponse.json({ error: 'User not found' }, { status: 404 });
            }

            // Only fetch from swarm nodes
            const isSwarm = await isSwarmNode(remote.domain);
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
                
                const posts = profileData.posts.map((post: any) => ({
                    id: post.id,
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
                    isSwarm: true,
                    nodeDomain: remote.domain,
                    originalPostId: post.id,
                }));

                return NextResponse.json({ posts, nextCursor: null });
            }

            return NextResponse.json({ posts: [] });
        }

        if (user.isSuspended) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        // Get user's posts with cursor-based pagination
        let whereConditions = and(eq(posts.userId, user.id), eq(posts.isRemoved, false));
        
        // If cursor provided, get posts older than the cursor
        if (cursor) {
            const cursorPost = await db.query.posts.findFirst({
                where: eq(posts.id, cursor),
            });
            if (cursorPost) {
                whereConditions = and(
                    eq(posts.userId, user.id),
                    eq(posts.isRemoved, false),
                    lt(posts.createdAt, cursorPost.createdAt)
                );
            }
        }
        
        let userPosts: any[] = await db.query.posts.findMany({
            where: whereConditions,
            with: {
                author: true,
                media: true,
                bot: true,
                replyTo: {
                    with: { author: true },
                },
            },
            orderBy: [desc(posts.createdAt)],
            limit,
        });

        // Populate isLiked and isReposted for authenticated users
        try {
            const { getSession } = await import('@/lib/auth');
            const session = await getSession();

            if (session?.user && userPosts.length > 0) {
                const viewer = session.user;
                const postIds = userPosts.map(p => p.id).filter(Boolean);

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

                    userPosts = userPosts.map(p => ({
                        ...p,
                        isLiked: likedPostIds.has(p.id),
                        isReposted: repostedPostIds.has(p.id),
                    }));
                }
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
