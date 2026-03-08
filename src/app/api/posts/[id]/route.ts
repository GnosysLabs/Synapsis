import { NextResponse } from 'next/server';
import { db, posts, users, media, remotePosts } from '@/db';
import { eq, desc, and, sql } from 'drizzle-orm';
import { z } from 'zod';

// Schema for local post ID (UUID)
const localPostIdSchema = z.string().uuid('Invalid post ID format');

// Schema for swarm post ID (swarm:domain:uuid)
const swarmPostIdSchema = z.string().regex(
  /^swarm:[^:]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'Invalid swarm post ID format'
);

// Combined schema that accepts either format
const postIdSchema = z.union([localPostIdSchema, swarmPostIdSchema]);

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id: rawId } = await params;
        // Decode URL-encoded characters (e.g., %3A -> :)
        const id = decodeURIComponent(rawId);

        const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:3000';

        let mainPost: any = null;
        let replyPosts: any[] = [];

        // Handle swarm post IDs (format: swarm:domain:uuid)
        if (id.startsWith('swarm:')) {
            const lastColonIndex = id.lastIndexOf(':');
            if (lastColonIndex > 6) {
                const originDomain = id.substring(6, lastColonIndex);
                const originalPostId = id.substring(lastColonIndex + 1);

                // Fetch from origin node in real-time
                try {
                    const protocol = originDomain.includes('localhost') ? 'http' : 'https';
                    const res = await fetch(`${protocol}://${originDomain}/api/swarm/posts/${originalPostId}`, {
                        headers: { 'Accept': 'application/json' },
                        signal: AbortSignal.timeout(10000),
                    });

                    if (res.ok) {
                        const data = await res.json();

                        // Transform to match expected format
                        mainPost = {
                            id: id,
                            originalPostId: originalPostId,
                            content: data.post.content,
                            createdAt: data.post.createdAt,
                            likesCount: data.post.likesCount || 0,
                            repostsCount: data.post.repostsCount || 0,
                            repliesCount: data.post.repliesCount || 0,
                            isSwarm: true,
                            nodeDomain: originDomain,
                            author: {
                                id: `swarm:${originDomain}:${data.post.author.handle}`,
                                handle: data.post.author.handle,
                                displayName: data.post.author.displayName,
                                avatarUrl: data.post.author.avatarUrl,
                                isSwarm: true,
                                nodeDomain: originDomain,
                            },
                            media: data.post.media?.map((m: any, idx: number) => ({
                                id: `swarm:${originDomain}:${originalPostId}:media:${idx}`,
                                url: m.url,
                                altText: m.altText || null,
                            })) || [],
                            linkPreviewUrl: data.post.linkPreviewUrl,
                            linkPreviewTitle: data.post.linkPreviewTitle,
                            linkPreviewDescription: data.post.linkPreviewDescription,
                            linkPreviewImage: data.post.linkPreviewImage,
                        };

                        // Transform replies
                        replyPosts = (data.replies || []).map((r: any) => ({
                            id: `swarm:${originDomain}:${r.id}`,
                            originalPostId: r.id,
                            content: r.content,
                            createdAt: r.createdAt,
                            likesCount: r.likesCount || 0,
                            repostsCount: r.repostsCount || 0,
                            repliesCount: r.repliesCount || 0,
                            isSwarm: true,
                            nodeDomain: originDomain,
                            author: {
                                id: `swarm:${originDomain}:${r.author.handle}`,
                                handle: r.author.handle,
                                displayName: r.author.displayName,
                                avatarUrl: r.author.avatarUrl,
                                isSwarm: true,
                                nodeDomain: originDomain,
                            },
                            media: r.media?.map((m: any, idx: number) => ({
                                id: `swarm:${originDomain}:${r.id}:media:${idx}`,
                                url: m.url,
                                altText: m.altText || null,
                            })) || [],
                        }));

                        // Check if current user has liked this post
                        try {
                            const { requireAuth } = await import('@/lib/auth');
                            const viewer = await requireAuth();

                            const likeCheckRes = await fetch(
                                `${protocol}://${originDomain}/api/swarm/posts/${originalPostId}/likes?checkHandle=${viewer.handle}&checkDomain=${nodeDomain}`,
                                { signal: AbortSignal.timeout(3000) }
                            );

                            if (likeCheckRes.ok) {
                                const likeData = await likeCheckRes.json();
                                mainPost.isLiked = likeData.isLiked;
                            }
                        } catch {
                            // Not logged in or timeout
                        }

                        return NextResponse.json({
                            post: mainPost,
                            replies: replyPosts,
                        });
                    }
                } catch (err) {
                    console.error(`[Swarm] Failed to fetch post from ${originDomain}:`, err);
                }

                return NextResponse.json({ error: 'Post not found' }, { status: 404 });
            }
        }

        const post = await db.query.posts.findFirst({
            where: eq(posts.id, id),
            with: {
                author: true,
                media: true,
                replyTo: {
                    with: { author: true },
                },
            },
        });

        if (post) {
            mainPost = post;

            const replies = await db.query.posts.findMany({
                where: and(
                    eq(posts.replyToId, id),
                    eq(posts.isRemoved, false)
                ),
                with: {
                    author: true,
                    media: true,
                },
                orderBy: [desc(posts.createdAt)],
            });

            let allPostIds = [post.id, ...replies.map(r => r.id)];

            try {
                const { requireAuth } = await import('@/lib/auth');
                const { likes } = await import('@/db');
                const { inArray } = await import('drizzle-orm');

                const viewer = await requireAuth();
                allPostIds = [post.id, ...replies.map(r => r.id)];

                if (allPostIds.length > 0) {
                    const viewerLikes = await db.query.likes.findMany({
                        where: and(
                            eq(likes.userId, viewer.id),
                            inArray(likes.postId, allPostIds)
                        ),
                    });
                    const likedPostIds = new Set(viewerLikes.map(l => l.postId));

                    const viewerReposts = await db.query.posts.findMany({
                        where: and(
                            eq(posts.userId, viewer.id),
                            inArray(posts.repostOfId, allPostIds),
                            eq(posts.isRemoved, false)
                        ),
                    });
                    const repostedPostIds = new Set(viewerReposts.map(r => r.repostOfId));

                    mainPost = {
                        ...post,
                        isLiked: likedPostIds.has(post.id),
                        isReposted: repostedPostIds.has(post.id),
                    } as any;

                    replyPosts = replies.map(r => ({
                        ...r,
                        isLiked: likedPostIds.has(r.id),
                        isReposted: repostedPostIds.has(r.id),
                    })) as any[];
                }
            } catch {
            }
        } else {
            const cached = await db.query.remotePosts.findFirst({
                where: eq(remotePosts.apId, id),
            });

            if (cached) {
                mainPost = {
                    id: cached.id,
                    content: cached.content,
                    createdAt: cached.publishedAt.toISOString(),
                    likesCount: 0,
                    repostsCount: 0,
                    repliesCount: 0,
                    author: {
                        id: cached.authorHandle,
                        handle: cached.authorHandle,
                        displayName: cached.authorDisplayName || cached.authorHandle,
                        avatarUrl: cached.authorAvatarUrl,
                        bio: null,
                        isRemote: true,
                    },
                    media: cached.mediaJson ? JSON.parse(cached.mediaJson) : null,
                    linkPreviewUrl: cached.linkPreviewUrl,
                    linkPreviewTitle: cached.linkPreviewTitle,
                    linkPreviewDescription: cached.linkPreviewDescription,
                    linkPreviewImage: cached.linkPreviewImage,
                    isLiked: false,
                    isReposted: false,
                };
            } else {
                // Remote posts are no longer supported outside of swarm
                return NextResponse.json({ error: 'Post not found' }, { status: 404 });
            }
        }

        if (!mainPost) {
            return NextResponse.json({ error: 'Post not found' }, { status: 404 });
        }

        return NextResponse.json({
            post: mainPost,
            replies: replyPosts,
        });
    } catch (error) {
        console.error('Get post detail error:', error);
        return NextResponse.json(
            { error: 'Failed to get post detail' },
            { status: 500 }
        );
    }
}

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { requireAuth } = await import('@/lib/auth');
        const { bots } = await import('@/db');
        const user = await requireAuth();
        const { id } = await params;

        const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:3000';

        // Handle swarm post IDs (format: swarm:domain:uuid)
        if (id.startsWith('swarm:')) {
            const lastColonIndex = id.lastIndexOf(':');
            if (lastColonIndex > 6) {
                const originDomain = id.substring(6, lastColonIndex);
                const originalPostId = id.substring(lastColonIndex + 1);

                // We need to fetch the post from the remote node to check if the current user is the author
                // The remote node should have the post with proper attribution
                try {
                    const protocol = originDomain.includes('localhost') ? 'http' : 'https';
                    const res = await fetch(`${protocol}://${originDomain}/api/swarm/posts/${originalPostId}`, {
                        headers: { 'Accept': 'application/json' },
                        signal: AbortSignal.timeout(5000),
                    });

                    if (res.ok) {
                        const data = await res.json();
                        const remotePost = data.post;

                        // Check authorship
                        // Format: handle or handle@domain
                        // If the user authored it, the remote post author handle should match current user handle
                        // AND the remote post author node domain should be THIS node

                        // The remote node returns author as: 
                        // { handle: "user", displayName: "...", nodeDomain: "our-domain" } 
                        // OR if it's a "local" user on that node (which shouldn't correspond to us unless we possess that account)

                        // In the swarm reply scenario, the remote node stores our user as a "remote user"
                        // Its logic: handle = "user@our-domain"

                        // So we check if remotePost.author.handle starts with user.handle
                        // AND (remotePost.author.handle ends with @nodeDomain OR remotePost.nodeDomain == nodeDomain?)

                        let isAuthor = false;
                        if (remotePost.author.handle === user.handle ||
                            remotePost.author.handle === `${user.handle}@${nodeDomain}`) {
                            isAuthor = true;
                        }

                        if (!isAuthor) {
                            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
                        }

                        // It is our post (or reply). We can delete it.
                        // We need the original ID that WE sent when creating it.
                        // Ideally, the remote node preserves the apId we sent, which contains our original ID.
                        // But the remote node endpoint returns 'apId', let's use that if available.

                        let replyIdToDelete = originalPostId; // Fallback to their ID if we can't find ours (unlikely to work for replies endpoint)

                        // If we are deleting a reply we sent
                        // The remote node has it stored. 
                        // We need to send DELETE /api/swarm/replies with { replyId: <OUR_ID> }
                        // The remote node checks `swarm:ourDomain:<OUR_ID>`

                        // We need to extract <OUR_ID> from the remote post's apId
                        // remotePost.apId should be `swarm:ourDomain:ourId`

                        if (remotePost.apId && remotePost.apId.startsWith(`swarm:${nodeDomain}:`)) {
                            const parts = remotePost.apId.split(':');
                            if (parts.length >= 3) {
                                replyIdToDelete = parts[2];
                            }
                        }

                        // Propagate deletion
                        const deleteRes = await fetch(`${protocol}://${originDomain}/api/swarm/replies`, {
                            method: 'DELETE',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                replyId: replyIdToDelete,
                                nodeDomain,
                                authorHandle: user.handle,
                            }),
                            signal: AbortSignal.timeout(5000),
                        });

                        if (deleteRes.ok) {
                            return NextResponse.json({ success: true });
                        } else {
                            return NextResponse.json({ error: 'Failed to delete on remote node' }, { status: deleteRes.status });
                        }
                    } else {
                        return NextResponse.json({ error: 'Remote post not found for verification' }, { status: 404 });
                    }
                } catch (err) {
                    console.error('[Swarm] Error deleting remote post:', err);
                    return NextResponse.json({ error: 'Failed to communicate with remote node' }, { status: 502 });
                }
            }
        }

        const post = await db.query.posts.findFirst({
            where: eq(posts.id, id),
            with: {
                bot: true,
            },
        });

        if (!post) {
            return NextResponse.json({ error: 'Post not found' }, { status: 404 });
        }

        // Allow deletion if user owns the post OR if user owns the bot that made the post
        // OR if user owns the parent post (can delete replies on their posts)
        const isPostOwner = post.userId === user.id;
        const isBotOwner = post.bot && post.bot.ownerId === user.id;

        // Check if user owns the parent post (for deleting replies on their posts)
        let isParentPostOwner = false;
        if (post.replyToId) {
            const parentPost = await db.query.posts.findFirst({
                where: eq(posts.id, post.replyToId),
            });
            if (parentPost && parentPost.userId === user.id) {
                isParentPostOwner = true;
            }
        }

        if (!isPostOwner && !isBotOwner && !isParentPostOwner) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
        }

        // 1. If it's a reply, decrement parent's repliesCount
        if (post.replyToId) {
            const parentPost = await db.query.posts.findFirst({
                where: eq(posts.id, post.replyToId),
            });
            if (parentPost && parentPost.repliesCount > 0) {
                await db.update(posts)
                    .set({ repliesCount: parentPost.repliesCount - 1 })
                    .where(eq(posts.id, post.replyToId));
            }
        }

        // 2. If this is a reply to a swarm post, notify the origin node to delete it
        if (post.swarmReplyToId) {
            // Correctly parse swarm:domain:postId where domain might contain port
            const lastColonIndex = post.swarmReplyToId.lastIndexOf(':');
            if (lastColonIndex > 6) { // 'swarm:'.length = 6
                const originDomain = post.swarmReplyToId.substring(6, lastColonIndex);

                // Propagate deletion to origin node
                try {
                    const protocol = originDomain.includes('localhost') ? 'http' : 'https';
                    const res = await fetch(`${protocol}://${originDomain}/api/swarm/replies`, {
                        method: 'DELETE',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            replyId: post.id,
                            nodeDomain,
                            authorHandle: user.handle,
                        }),
                        signal: AbortSignal.timeout(5000),
                    });

                    if (res.ok) {
                        console.log(`[Swarm] Deletion propagated to ${originDomain}`);
                    } else {
                        console.error(`[Swarm] Failed to propagate deletion: ${res.status}`);
                    }
                } catch (err) {
                    console.error('[Swarm] Error propagating deletion:', err);
                }
            }
        }

        // 3. Delete the post (cascades to media, likes, notifications)
        await db.delete(posts).where(eq(posts.id, id));

        // 4. Decrement the post author's postsCount (atomic decrement, clamped to 0)
        await db.update(users)
            .set({ postsCount: sql`GREATEST(0, ${users.postsCount} - 1)` })
            .where(eq(users.id, post.userId));

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Delete post error:', error);
        if (error instanceof Error && error.message === 'Authentication required') {
            return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
        }
        return NextResponse.json(
            { error: 'Failed to delete post' },
            { status: 500 }
        );
    }
}
