import { NextResponse } from 'next/server';
import { db, posts, users, notifications, userSwarmReposts } from '@/db';
import { requireAuth } from '@/lib/auth';
import { eq, and, sql } from 'drizzle-orm';
import { z } from 'zod';
import crypto from 'crypto';
import { buildNotificationTarget } from '@/lib/notifications';
import { serializeLinkPreviewMedia } from '@/lib/media/linkPreview';

type RouteContext = { params: Promise<{ id: string }> };

// UUID or swarm post ID format (swarm:domain:uuid)
const postIdSchema = z.union([
    z.string().uuid(),
    z.string().regex(/^swarm:[^:]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'Invalid swarm post ID format'),
]);

/**
 * Extract domain from a swarm post ID (swarm:domain:postId)
 */
function extractSwarmDomain(apId: string | null): string | null {
    if (!apId?.startsWith('swarm:')) return null;
    const lastColonIndex = apId.lastIndexOf(':');
    if (lastColonIndex <= 6) return null;
    return apId.substring(6, lastColonIndex);
}

/**
 * Check if a post is from a swarm node
 */
function isSwarmPost(apId: string | null): boolean {
    return apId?.startsWith('swarm:') ?? false;
}

/**
 * Extract the original post ID from a swarm apId
 */
function extractSwarmPostId(apId: string): string | null {
    if (!apId) return null;
    const lastColonIndex = apId.lastIndexOf(':');
    if (lastColonIndex === -1) return null;
    return apId.substring(lastColonIndex + 1);
}

async function fetchSwarmPostSnapshot(domain: string, originalPostId: string) {
    try {
        const protocol = domain.includes('localhost') ? 'http' : 'https';
        const res = await fetch(`${protocol}://${domain}/api/swarm/posts/${originalPostId}`, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(5000),
        });

        if (!res.ok) {
            return null;
        }

        const data = await res.json();
        const post = data.post;
        if (!post) {
            return null;
        }

        return {
            authorHandle: post.author?.handle || 'unknown',
            authorDisplayName: post.author?.displayName || post.author?.handle || 'Unknown',
            authorAvatarUrl: post.author?.avatarUrl || null,
            content: post.content || '',
            postCreatedAt: new Date(post.createdAt || new Date().toISOString()),
            likesCount: post.likesCount || 0,
            repostsCount: post.repostsCount || 0,
            repliesCount: post.repliesCount || 0,
            linkPreviewUrl: post.linkPreviewUrl || null,
            linkPreviewTitle: post.linkPreviewTitle || null,
            linkPreviewDescription: post.linkPreviewDescription || null,
            linkPreviewImage: post.linkPreviewImage || null,
            linkPreviewType: post.linkPreviewType || null,
            linkPreviewVideoUrl: post.linkPreviewVideoUrl || null,
            linkPreviewMediaJson: serializeLinkPreviewMedia(post.linkPreviewMedia),
            mediaJson: post.media ? JSON.stringify(post.media) : null,
        };
    } catch {
        return null;
    }
}

// Repost a post
export async function POST(request: Request, context: RouteContext) {
    try {
        const user = await requireAuth();
        const { id: rawId } = await context.params;
        const decodedId = decodeURIComponent(rawId);
        const postId = postIdSchema.parse(decodedId);
        const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:3000';

        if (user.isSuspended || user.isSilenced) {
            return NextResponse.json({ error: 'Account restricted' }, { status: 403 });
        }

        // Handle swarm posts (format: swarm:domain:uuid)
        if (postId.startsWith('swarm:')) {
            const targetDomain = extractSwarmDomain(postId);
            const originalPostId = extractSwarmPostId(postId);

            if (!targetDomain || !originalPostId) {
                return NextResponse.json({ error: 'Invalid swarm post ID' }, { status: 400 });
            }

            const existingRepost = await db.query.userSwarmReposts.findFirst({
                where: and(
                    eq(userSwarmReposts.userId, user.id),
                    eq(userSwarmReposts.nodeDomain, targetDomain),
                    eq(userSwarmReposts.originalPostId, originalPostId),
                ),
            });

            if (existingRepost) {
                return NextResponse.json({ error: 'Already reposted' }, { status: 400 });
            }

            // Deliver repost directly to the origin node
            const { deliverSwarmRepost } = await import('@/lib/swarm/interactions');

            const result = await deliverSwarmRepost(targetDomain, {
                postId: originalPostId,
                repost: {
                    actorHandle: user.handle,
                    actorDisplayName: user.displayName || user.handle,
                    actorAvatarUrl: user.avatarUrl || undefined,
                    actorNodeDomain: nodeDomain,
                    repostId: crypto.randomUUID(),
                    interactionId: crypto.randomUUID(),
                    timestamp: new Date().toISOString(),
                },
            });

            if (!result.success) {
                console.error(`[Swarm] Repost delivery failed: ${result.error}`);
                return NextResponse.json({ error: 'Failed to deliver repost to remote node' }, { status: 502 });
            }

            const snapshot = await fetchSwarmPostSnapshot(targetDomain, originalPostId);
            if (snapshot) {
                await db.insert(userSwarmReposts).values({
                    userId: user.id,
                    nodeDomain: targetDomain,
                    originalPostId,
                    ...snapshot,
                    repostedAt: new Date(),
                }).onConflictDoUpdate({
                    target: [userSwarmReposts.userId, userSwarmReposts.nodeDomain, userSwarmReposts.originalPostId],
                    set: {
                        ...snapshot,
                        repostedAt: new Date(),
                    },
                });
            }

            await db.update(users)
                .set({ postsCount: sql`${users.postsCount} + 1` })
                .where(eq(users.id, user.id));

            console.log(`[Swarm] Repost delivered to ${targetDomain} for post ${originalPostId}`);
            return NextResponse.json({ success: true, reposted: true });
        }

        // Local post - check if it exists
        const originalPost = await db.query.posts.findFirst({
            where: eq(posts.id, postId),
        });

        if (!originalPost) {
            return NextResponse.json({ error: 'Post not found' }, { status: 404 });
        }
        if (originalPost.isRemoved) {
            return NextResponse.json({ error: 'Post not found' }, { status: 404 });
        }

        // Check if already reposted by this user
        const existingRepost = await db.query.posts.findFirst({
            where: and(
                eq(posts.userId, user.id),
                eq(posts.repostOfId, postId),
                eq(posts.isRemoved, false)
            ),
        });

        if (existingRepost) {
            return NextResponse.json({ error: 'Already reposted' }, { status: 400 });
        }

        // Create repost
        const repostId = crypto.randomUUID();
        const [repost] = await db.insert(posts).values({
            userId: user.id,
            content: '', // Reposts don't have their own content
            repostOfId: postId,
            apId: `https://${nodeDomain}/posts/${repostId}`,
            apUrl: `https://${nodeDomain}/posts/${repostId}`,
        }).returning();

        // Update original post's repost count
        await db.update(posts)
            .set({ repostsCount: sql`${posts.repostsCount} + 1` })
            .where(eq(posts.id, postId));

        // Update user's post count
        await db.update(users)
            .set({ postsCount: sql`${users.postsCount} + 1` })
            .where(eq(users.id, user.id));

        if (originalPost.userId !== user.id) {
            const postAuthor = await db.query.users.findFirst({
                where: eq(users.id, originalPost.userId),
            });

            // Create notification with actor info stored directly
            await db.insert(notifications).values({
                userId: originalPost.userId,
                actorId: user.id,
                actorHandle: user.handle,
                actorDisplayName: user.displayName,
                actorAvatarUrl: user.avatarUrl,
                actorNodeDomain: null, // Local user
                postId,
                postContent: originalPost.content?.slice(0, 200) || null,
                ...(postAuthor?.isBot ? buildNotificationTarget(postAuthor) : {}),
                type: 'repost',
            });

            // Also notify bot owner if this is a bot's post
            if (postAuthor?.isBot && postAuthor.botOwnerId) {
                await db.insert(notifications).values({
                    userId: postAuthor.botOwnerId,
                    actorId: user.id,
                    actorHandle: user.handle,
                    actorDisplayName: user.displayName,
                    actorAvatarUrl: user.avatarUrl,
                    actorNodeDomain: null,
                    postId,
                    postContent: originalPost.content?.slice(0, 200) || null,
                    ...buildNotificationTarget(postAuthor),
                    type: 'repost',
                });
            }
        }

        // SWARM-FIRST: Deliver repost to swarm node
        if (isSwarmPost(originalPost.apId)) {
            const targetDomain = extractSwarmDomain(originalPost.apId);
            const originalPostIdOnRemote = extractSwarmPostId(originalPost.apId!);

            if (targetDomain && originalPostIdOnRemote) {
                (async () => {
                    try {
                        const { deliverSwarmRepost } = await import('@/lib/swarm/interactions');

                        const result = await deliverSwarmRepost(targetDomain, {
                            postId: originalPostIdOnRemote,
                            repost: {
                                actorHandle: user.handle,
                                actorDisplayName: user.displayName || user.handle,
                                actorAvatarUrl: user.avatarUrl || undefined,
                                actorNodeDomain: nodeDomain,
                                repostId: repost.id,
                                interactionId: crypto.randomUUID(),
                                timestamp: new Date().toISOString(),
                            },
                        });

                        if (result.success) {
                            console.log(`[Swarm] Repost delivered to ${targetDomain}`);
                        } else {
                            console.warn(`[Swarm] Repost delivery failed: ${result.error}`);
                        }
                    } catch (err) {
                        console.error('[Swarm] Error delivering repost:', err);
                    }
                })();
            }
        } else if (originalPost.apId) {
            // Non-swarm posts with apId are legacy - no federation needed
        }

        return NextResponse.json({ success: true, repost, reposted: true });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return NextResponse.json({ error: 'Invalid post ID', details: error.issues }, { status: 400 });
        }
        if (error instanceof Error && error.message === 'Authentication required') {
            return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
        }
        return NextResponse.json({ error: 'Failed to repost' }, { status: 500 });
    }
}

// Unrepost a post
export async function DELETE(request: Request, context: RouteContext) {
    try {
        const user = await requireAuth();
        const { id: rawId } = await context.params;
        const decodedId = decodeURIComponent(rawId);
        const postId = postIdSchema.parse(decodedId);
        const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:3000';

        if (user.isSuspended || user.isSilenced) {
            return NextResponse.json({ error: 'Account restricted' }, { status: 403 });
        }

        // Handle swarm posts (format: swarm:domain:uuid)
        if (postId.startsWith('swarm:')) {
            const targetDomain = extractSwarmDomain(postId);
            const originalPostId = extractSwarmPostId(postId);

            if (!targetDomain || !originalPostId) {
                return NextResponse.json({ error: 'Invalid swarm post ID' }, { status: 400 });
            }

            const existingRepost = await db.query.userSwarmReposts.findFirst({
                where: and(
                    eq(userSwarmReposts.userId, user.id),
                    eq(userSwarmReposts.nodeDomain, targetDomain),
                    eq(userSwarmReposts.originalPostId, originalPostId),
                ),
            });

            if (!existingRepost) {
                return NextResponse.json({ error: 'Not reposted' }, { status: 400 });
            }

            // Deliver unrepost directly to the origin node
            const { deliverSwarmUnrepost } = await import('@/lib/swarm/interactions');

            const result = await deliverSwarmUnrepost(targetDomain, {
                postId: originalPostId,
                unrepost: {
                    actorHandle: user.handle,
                    actorNodeDomain: nodeDomain,
                    interactionId: crypto.randomUUID(),
                    timestamp: new Date().toISOString(),
                },
            });

            if (!result.success) {
                console.error(`[Swarm] Unrepost delivery failed: ${result.error}`);
                return NextResponse.json({ error: 'Failed to deliver unrepost to remote node' }, { status: 502 });
            }

            await db.delete(userSwarmReposts).where(and(
                eq(userSwarmReposts.userId, user.id),
                eq(userSwarmReposts.nodeDomain, targetDomain),
                eq(userSwarmReposts.originalPostId, originalPostId),
            ));

            await db.update(users)
                .set({ postsCount: sql`GREATEST(0, ${users.postsCount} - 1)` })
                .where(eq(users.id, user.id));

            console.log(`[Swarm] Unrepost delivered to ${targetDomain} for post ${originalPostId}`);
            return NextResponse.json({ success: true, reposted: false });
        }

        // Local post - check if original post exists
        const originalPost = await db.query.posts.findFirst({
            where: eq(posts.id, postId),
        });

        // Find the repost by this user
        const repost = await db.query.posts.findFirst({
            where: and(
                eq(posts.userId, user.id),
                eq(posts.repostOfId, postId),
                eq(posts.isRemoved, false)
            ),
        });

        if (!repost) {
            return NextResponse.json({ error: 'Not reposted' }, { status: 400 });
        }

        // Mark repost as removed
        await db.update(posts)
            .set({ isRemoved: true })
            .where(eq(posts.id, repost.id));

        // Update original post's repost count
        if (originalPost) {
            await db.update(posts)
                .set({ repostsCount: sql`GREATEST(0, ${posts.repostsCount} - 1)` })
                .where(eq(posts.id, postId));
        }

        // Update user's post count
        await db.update(users)
            .set({ postsCount: sql`GREATEST(0, ${users.postsCount} - 1)` })
            .where(eq(users.id, user.id));

        return NextResponse.json({ success: true, reposted: false });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return NextResponse.json({ error: 'Invalid post ID', details: error.issues }, { status: 400 });
        }
        if (error instanceof Error && error.message === 'Authentication required') {
            return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
        }
        return NextResponse.json({ error: 'Failed to unrepost' }, { status: 500 });
    }
}
