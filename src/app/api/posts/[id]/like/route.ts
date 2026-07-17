import { NextResponse } from 'next/server';
import { db, posts, likes, notifications, remoteLikes, userSwarmLikes } from '@/db';
import { requireAuth } from '@/lib/auth';
import { requireSignedAction, type SignedAction } from '@/lib/auth/verify-signature';
import { eq, and, sql } from 'drizzle-orm';
import { z } from 'zod';
import crypto from 'crypto';
import { serializeLinkPreviewMedia } from '@/lib/media/linkPreview';
import { signedFederationRead } from '@/lib/swarm/signed-read';

type SwarmPostSnapshotResponse = {
    post?: {
        author?: { handle?: string; displayName?: string; avatarUrl?: string | null };
        content?: string;
        createdAt?: string;
        likesCount?: number;
        repostsCount?: number;
        repliesCount?: number;
        linkPreviewUrl?: string | null;
        linkPreviewTitle?: string | null;
        linkPreviewDescription?: string | null;
        linkPreviewImage?: string | null;
        linkPreviewType?: string | null;
        linkPreviewVideoUrl?: string | null;
        linkPreviewMedia?: Array<{
            url: string;
            width?: number | null;
            height?: number | null;
            mimeType?: string | null;
        }> | null;
        media?: unknown[];
    };
};
import { normalizeSameNodePostId, parseSwarmPostId } from '@/lib/swarm/post-id';

type RouteContext = { params: Promise<{ id: string }> };

// UUID or swarm post ID format (swarm:domain:uuid)
const postIdSchema = z.union([
    z.string().uuid(),
    z.string().refine((value) => parseSwarmPostId(value) !== null, 'Invalid swarm post ID format'),
]);

function isSignedActionPayload(payload: unknown): payload is SignedAction {
    if (!payload || typeof payload !== 'object') return false;
    const value = payload as Record<string, unknown>;
    return typeof value.action === 'string'
        && typeof value.did === 'string'
        && typeof value.handle === 'string'
        && typeof value.ts === 'number'
        && typeof value.nonce === 'string'
        && typeof value.sig === 'string'
        && typeof value.data === 'object'
        && value.data !== null;
}

async function readOptionalJson(request: Request) {
    const rawBody = await request.text();
    if (!rawBody.trim()) return null;
    return JSON.parse(rawBody);
}

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
 * Check if a post is from a swarm node (has swarm: prefix in apId)
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
        const res = await signedFederationRead(`${protocol}://${domain}/api/swarm/posts/${originalPostId}`, {
            headers: { Accept: 'application/json' },
            timeoutMs: 5_000,
            maxResponseBytes: 1024 * 1024,
        });

        if (res.status < 200 || res.status >= 300) {
            return null;
        }

        const data = res.json() as SwarmPostSnapshotResponse;
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

// Like a post
export async function POST(request: Request, context: RouteContext) {
    try {
        const body = await readOptionalJson(request);
        const { id: paramId } = await context.params;
        const decodedParamId = decodeURIComponent(paramId);

        const user = isSignedActionPayload(body)
            ? await requireSignedAction(body)
            : await requireAuth();

        if (isSignedActionPayload(body) && body.data?.postId && body.data.postId !== decodedParamId) {
            return NextResponse.json({ error: 'Post ID mismatch' }, { status: 400 });
        }

        const decodedId = decodedParamId;
        let postId = postIdSchema.parse(decodedId);
        const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';
        postId = normalizeSameNodePostId(postId, nodeDomain);

        if (user.isSuspended || user.isSilenced) {
            return NextResponse.json({ error: 'Account restricted' }, { status: 403 });
        }

        // Handle swarm posts (format: swarm:domain:uuid)
        if (postId.startsWith('swarm:')) {
            const parsedSwarmId = parseSwarmPostId(postId);
            if (!parsedSwarmId) {
                return NextResponse.json({ error: 'Invalid swarm post ID' }, { status: 400 });
            }
            const { domain: targetDomain, originalPostId } = parsedSwarmId;

            // Deliver like directly to the origin node
            const { deliverSwarmLike } = await import('@/lib/swarm/interactions');

            const result = await deliverSwarmLike(targetDomain, {
                postId: originalPostId,
                like: {
                    actorHandle: user.handle,
                    actorDisplayName: user.displayName || user.handle,
                    actorAvatarUrl: user.avatarUrl || undefined,
                    actorNodeDomain: nodeDomain,
                    interactionId: crypto.randomUUID(),
                    timestamp: new Date().toISOString(),
                },
            });

            if (!result.success) {
                console.error(`[Swarm] Like delivery failed: ${result.error}`);
                return NextResponse.json({ error: 'Failed to deliver like to remote node' }, { status: 502 });
            }

            const snapshot = await fetchSwarmPostSnapshot(targetDomain, originalPostId);
            if (snapshot) {
                await db.insert(userSwarmLikes).values({
                    userId: user.id,
                    nodeDomain: targetDomain,
                    originalPostId,
                    ...snapshot,
                    likedAt: new Date(),
                }).onConflictDoUpdate({
                    target: [userSwarmLikes.userId, userSwarmLikes.nodeDomain, userSwarmLikes.originalPostId],
                    set: {
                        ...snapshot,
                        likedAt: new Date(),
                    },
                });
            }

            console.log(`[Swarm] Like delivered to ${targetDomain} for post ${originalPostId}`);
            return NextResponse.json({ success: true, liked: true });
        }

        // Local post - check if it exists
        const post = await db.query.posts.findFirst({
            where: { id: postId },
        });

        if (!post) {
            return NextResponse.json({ error: 'Post not found' }, { status: 404 });
        }
        if (post.isRemoved) {
            return NextResponse.json({ error: 'Post not found' }, { status: 404 });
        }

        // Check if already liked
        const existingLike = await db.query.likes.findFirst({
            where: { AND: [{ userId: user.id }, { postId: postId }] },
        });

        if (existingLike) {
            return NextResponse.json({ error: 'Already liked' }, { status: 400 });
        }

        const legacySameNodeLike = await db.query.userSwarmLikes.findFirst({
            where: { AND: [{ userId: user.id }, { nodeDomain }, { originalPostId: postId }] },
        });
        if (legacySameNodeLike) {
            return NextResponse.json({ error: 'Already liked' }, { status: 400 });
        }

        // Create like
        await db.insert(likes).values({
            userId: user.id,
            postId,
        });

        // Update post's like count (atomic increment)
        await db.update(posts)
            .set({ likesCount: sql`${posts.likesCount} + 1` })
            .where(eq(posts.id, postId));

        if (post.userId !== user.id) {
            // Create notification with actor info stored directly
            await db.insert(notifications).values({
                userId: post.userId,
                actorId: user.id,
                actorHandle: user.handle,
                actorDisplayName: user.displayName,
                actorAvatarUrl: user.avatarUrl,
                actorNodeDomain: null, // Local user
                postId,
                postContent: post.content?.slice(0, 200) || null,
                type: 'like',
            });
        }

        // If this is a cached swarm post (has swarm: apId), also deliver to origin
        if (isSwarmPost(post.apId)) {
            const targetDomain = extractSwarmDomain(post.apId);
            const originalPostId = extractSwarmPostId(post.apId!);

            if (targetDomain && originalPostId) {
                (async () => {
                    try {
                        const { deliverSwarmLike } = await import('@/lib/swarm/interactions');

                        const result = await deliverSwarmLike(targetDomain, {
                            postId: originalPostId,
                            like: {
                                actorHandle: user.handle,
                                actorDisplayName: user.displayName || user.handle,
                                actorAvatarUrl: user.avatarUrl || undefined,
                                actorNodeDomain: nodeDomain,
                                interactionId: crypto.randomUUID(),
                                timestamp: new Date().toISOString(),
                            },
                        });

                        if (result.success) {
                            console.log(`[Swarm] Like delivered to ${targetDomain} for post ${originalPostId}`);
                        } else {
                            console.warn(`[Swarm] Like delivery failed: ${result.error}`);
                        }
                    } catch (err) {
                        // Log error with context but don't fail the request - swarm delivery is best-effort
                        console.error('[Like] Error delivering like to swarm:', err);
                        console.error('[Like] Context:', { postId: originalPostId, userId: user.id, targetDomain });
                    }
                })();
            }
        } else if (post.apId) {
            // Non-swarm posts with apId are legacy - no federation needed
        }

        return NextResponse.json({ success: true, liked: true });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return NextResponse.json({ error: 'Invalid post ID', details: error.issues }, { status: 400 });
        }
        if (error instanceof Error) {
            // Handle signature verification errors
            if (error.message === 'User not found' ||
                error.message === 'Handle mismatch' ||
                error.message === 'Invalid signature' ||
                error.message === 'Timestamp too old or in future') {
                return NextResponse.json({ error: error.message }, { status: 403 });
            }
            if (error.message === 'Authentication required') {
                return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
            }
        }
        return NextResponse.json({ error: 'Failed to like post' }, { status: 500 });
    }
}

// Unlike a post
export async function DELETE(request: Request, context: RouteContext) {
    try {
        const body = await readOptionalJson(request);
        const { id: paramId } = await context.params;
        const decodedParamId = decodeURIComponent(paramId);

        const user = isSignedActionPayload(body)
            ? await requireSignedAction(body)
            : await requireAuth();

        if (isSignedActionPayload(body) && body.data?.postId && body.data.postId !== decodedParamId) {
            return NextResponse.json({ error: 'Post ID mismatch' }, { status: 400 });
        }

        const decodedId = decodedParamId;
        let postId = postIdSchema.parse(decodedId);
        const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';
        postId = normalizeSameNodePostId(postId, nodeDomain);

        if (user.isSuspended || user.isSilenced) {
            return NextResponse.json({ error: 'Account restricted' }, { status: 403 });
        }

        // Handle swarm posts (format: swarm:domain:uuid)
        if (postId.startsWith('swarm:')) {
            const parsedSwarmId = parseSwarmPostId(postId);
            if (!parsedSwarmId) {
                return NextResponse.json({ error: 'Invalid swarm post ID' }, { status: 400 });
            }
            const { domain: targetDomain, originalPostId } = parsedSwarmId;

            // Deliver unlike directly to the origin node
            const { deliverSwarmUnlike } = await import('@/lib/swarm/interactions');

            const result = await deliverSwarmUnlike(targetDomain, {
                postId: originalPostId,
                unlike: {
                    actorHandle: user.handle,
                    actorNodeDomain: nodeDomain,
                    interactionId: crypto.randomUUID(),
                    timestamp: new Date().toISOString(),
                },
            });

            if (!result.success) {
                console.error(`[Swarm] Unlike delivery failed: ${result.error}`);
                return NextResponse.json({ error: 'Failed to deliver unlike to remote node' }, { status: 502 });
            }

            await db.delete(userSwarmLikes).where(and(
                eq(userSwarmLikes.userId, user.id),
                eq(userSwarmLikes.nodeDomain, targetDomain),
                eq(userSwarmLikes.originalPostId, originalPostId)
            ));

            console.log(`[Swarm] Unlike delivered to ${targetDomain} for post ${originalPostId}`);
            return NextResponse.json({ success: true, liked: false });
        }

        // Local post - check if it exists
        const post = await db.query.posts.findFirst({
            where: { id: postId },
        });

        if (!post) {
            return NextResponse.json({ error: 'Post not found' }, { status: 404 });
        }
        if (post.isRemoved) {
            return NextResponse.json({ error: 'Post not found' }, { status: 404 });
        }

        // Find the like
        const existingLike = await db.query.likes.findFirst({
            where: { AND: [{ userId: user.id }, { postId: postId }] },
        });

        if (!existingLike) {
            const legacySameNodeLike = await db.query.userSwarmLikes.findFirst({
                where: { AND: [{ userId: user.id }, { nodeDomain }, { originalPostId: postId }] },
            });
            if (!legacySameNodeLike) {
                return NextResponse.json({ error: 'Not liked' }, { status: 400 });
            }

            await Promise.all([
                db.delete(userSwarmLikes).where(eq(userSwarmLikes.id, legacySameNodeLike.id)),
                db.delete(remoteLikes).where(and(
                    eq(remoteLikes.postId, postId),
                    eq(remoteLikes.actorHandle, user.handle),
                    eq(remoteLikes.actorNodeDomain, nodeDomain),
                )),
            ]);
            await db.update(posts)
                .set({ likesCount: sql`max(0, ${posts.likesCount} - 1)` })
                .where(eq(posts.id, postId));
            return NextResponse.json({ success: true, liked: false });
        }

        // Remove like
        await db.delete(likes).where(eq(likes.id, existingLike.id));

        // Update post's like count (atomic decrement, clamped to 0)
        await db.update(posts)
            .set({ likesCount: sql`max(0, ${posts.likesCount} - 1)` })
            .where(eq(posts.id, postId));

        // SWARM-FIRST: Deliver unlike to swarm node
        if (isSwarmPost(post.apId)) {
            const targetDomain = extractSwarmDomain(post.apId);
            const originalPostId = extractSwarmPostId(post.apId!);

            if (targetDomain && originalPostId) {
                (async () => {
                    try {
                        const { deliverSwarmUnlike } = await import('@/lib/swarm/interactions');

                        const result = await deliverSwarmUnlike(targetDomain, {
                            postId: originalPostId,
                            unlike: {
                                actorHandle: user.handle,
                                actorNodeDomain: nodeDomain,
                                interactionId: crypto.randomUUID(),
                                timestamp: new Date().toISOString(),
                            },
                        });

                        if (result.success) {
                            console.log(`[Swarm] Unlike delivered to ${targetDomain}`);
                        } else {
                            console.warn(`[Swarm] Unlike delivery failed: ${result.error}`);
                        }
                    } catch (err) {
                        // Log error with context but don't fail the request - swarm delivery is best-effort
                        console.error('[Like] Error delivering unlike to swarm:', err);
                        console.error('[Like] Context:', { postId: originalPostId, userId: user.id, targetDomain });
                    }
                })();
            }
        }

        return NextResponse.json({ success: true, liked: false });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return NextResponse.json({ error: 'Invalid post ID', details: error.issues }, { status: 400 });
        }
        if (error instanceof Error) {
            // Handle signature verification errors
            if (error.message === 'User not found' ||
                error.message === 'Handle mismatch' ||
                error.message === 'Invalid signature' ||
                error.message === 'Timestamp too old or in future') {
                return NextResponse.json({ error: error.message }, { status: 403 });
            }
            if (error.message === 'Authentication required') {
                return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
            }
        }
        return NextResponse.json({ error: 'Failed to unlike post' }, { status: 500 });
    }
}
