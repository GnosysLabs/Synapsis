import { NextResponse } from 'next/server';
import { db, posts, users, notifications, remoteReposts, userSwarmReposts } from '@/db';
import { requireAuth } from '@/lib/auth';
import { requireSignedAction, type SignedAction } from '@/lib/auth/verify-signature';
import { eq, and, sql } from 'drizzle-orm';
import { z } from 'zod';
import crypto from 'crypto';
import { normalizeSameNodePostId, parseSwarmPostId } from '@/lib/swarm/post-id';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { fetchRemotePostSnapshot } from '@/lib/swarm/remote-post-snapshot';
import { NODE_BLOCKED_CODE } from '@/lib/swarm/remote-access-protocol';
import { requireCanonicalAccountHomeDomain } from '@/lib/identity/account-address';
import { isNodeBlocked } from '@/lib/swarm/node-blocklist';

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

async function removeLocalSwarmRepost(
    userId: string,
    nodeDomain: string,
    originalPostId: string,
): Promise<boolean> {
    return db.transaction(async (tx) => {
        const storedRepost = await tx.query.userSwarmReposts.findFirst({
            where: { AND: [{ userId }, { nodeDomain }, { originalPostId }] },
        });
        if (!storedRepost) return false;

        await tx.delete(userSwarmReposts).where(eq(userSwarmReposts.id, storedRepost.id));
        await tx.update(users)
            .set({ postsCount: sql`max(0, ${users.postsCount} - 1)` })
            .where(eq(users.id, userId));
        return true;
    });
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

// Repost a post
export async function POST(request: Request, context: RouteContext) {
    try {
        const body = await readOptionalJson(request);
        const signedAction = isSignedActionPayload(body) ? body : null;
        const user = signedAction
            ? await requireSignedAction(signedAction, 'repost')
            : await requireAuth();
        const { id: rawId } = await context.params;
        const decodedId = decodeURIComponent(rawId);
        if (signedAction?.data?.postId !== undefined
            && signedAction.data.postId !== decodedId) {
            return NextResponse.json({ error: 'Post ID mismatch' }, { status: 400 });
        }
        let postId = postIdSchema.parse(decodedId);
        const nodeDomain = requireCanonicalAccountHomeDomain(
            process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
        );
        postId = normalizeSameNodePostId(postId, nodeDomain);

        if (user.isSuspended || user.isSilenced) {
            return NextResponse.json({ error: 'Account restricted' }, { status: 403 });
        }
        const actorIsNsfw = user.isNsfw || await requireLocalNodeNsfwClassification();

        // Handle swarm posts (format: swarm:domain:uuid)
        if (postId.startsWith('swarm:')) {
            if (!signedAction) {
                return NextResponse.json(
                    { error: 'Remote reposts require a signed user action' },
                    { status: 428 },
                );
            }
            const parsedSwarmId = parseSwarmPostId(postId);
            if (!parsedSwarmId) {
                return NextResponse.json({ error: 'Invalid swarm post ID' }, { status: 400 });
            }
            const { domain: targetDomain, originalPostId } = parsedSwarmId;
            if (await isNodeBlocked(targetDomain)) {
                return NextResponse.json({
                    error: 'This node is blocked by the local administrator.',
                    code: 'NODE_BLOCKED_LOCALLY',
                }, { status: 403 });
            }

            const existingRepost = await db.query.userSwarmReposts.findFirst({
                where: { AND: [{ userId: user.id }, { nodeDomain: targetDomain }, { originalPostId: originalPostId }] },
            });

            // Deliver repost directly to the origin node
            const { deliverSwarmRepost } = await import('@/lib/swarm/interactions');

            const result = await deliverSwarmRepost(targetDomain, {
                userAction: signedAction,
                postId: originalPostId,
                repost: {
                    actorHandle: user.handle,
                    actorDisplayName: user.displayName || user.handle,
                    actorAvatarUrl: user.avatarUrl || undefined,
                    actorIsNsfw,
                    actorNodeDomain: nodeDomain,
                    repostId: crypto.randomUUID(),
                    interactionId: crypto.randomUUID(),
                    timestamp: new Date().toISOString(),
                },
            });

            if (!result.success) {
                console.error(`[Swarm] Repost delivery failed: ${result.error}`);
                if (result.code === NODE_BLOCKED_CODE) {
                    return NextResponse.json({
                        error: 'This origin has blocked federation access from this node.',
                        code: NODE_BLOCKED_CODE,
                    }, { status: 403 });
                }
                return NextResponse.json({ error: 'Failed to deliver repost to remote node' }, { status: 502 });
            }

            const snapshot = await fetchRemotePostSnapshot(targetDomain, originalPostId);
            if (snapshot) {
                await db.insert(userSwarmReposts).values({
                    userId: user.id,
                    nodeDomain: targetDomain,
                    originalPostId,
                    ...snapshot,
                    originUnavailableAt: null,
                    repostedAt: new Date(),
                }).onConflictDoUpdate({
                    target: [userSwarmReposts.userId, userSwarmReposts.nodeDomain, userSwarmReposts.originalPostId],
                    set: {
                        ...snapshot,
                        originUnavailableAt: null,
                        repostedAt: new Date(),
                    },
                });
            }

            if (!existingRepost) {
                await db.update(users)
                    .set({ postsCount: sql`${users.postsCount} + 1` })
                    .where(eq(users.id, user.id));
            }

            console.log(`[Swarm] Repost delivered to ${targetDomain} for post ${originalPostId}`);
            return NextResponse.json({ success: true, reposted: true });
        }

        // Local post - check if it exists
        const originalPost = await db.query.posts.findFirst({
            where: { id: postId },
        });

        if (!originalPost) {
            return NextResponse.json({ error: 'Post not found' }, { status: 404 });
        }
        if (originalPost.isRemoved) {
            return NextResponse.json({ error: 'Post not found' }, { status: 404 });
        }

        // Check if already reposted by this user
        const existingRepost = await db.query.posts.findFirst({
            where: { AND: [{ userId: user.id }, { repostOfId: postId }, { isRemoved: false }] },
        });

        if (existingRepost) {
            return NextResponse.json({ success: true, repost: existingRepost, reposted: true });
        }

        const legacySameNodeRepost = await db.query.userSwarmReposts.findFirst({
            where: { AND: [{ userId: user.id }, { nodeDomain }, { originalPostId: postId }] },
        });
        if (legacySameNodeRepost) {
            return NextResponse.json({ success: true, reposted: true });
        }

        // Create repost
        const repostId = crypto.randomUUID();
        const [repost] = await db.insert(posts).values({
            userId: user.id,
            content: '', // Reposts don't have their own content
            repostOfId: postId,
            // A repost wrapper must never make a sensitive original look safe.
            isNsfw: originalPost.isNsfw || user.isNsfw,
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
            // Create notification with actor info stored directly
            await db.insert(notifications).values({
                userId: originalPost.userId,
                actorId: user.id,
                actorHandle: user.handle,
                actorDisplayName: user.displayName,
                actorAvatarUrl: user.avatarUrl,
                actorNodeDomain: user.homeDomain,
                postId,
                postContent: originalPost.content?.slice(0, 200) || null,
                type: 'repost',
            });
        }

        // SWARM-FIRST: Deliver repost to swarm node
        if (isSwarmPost(originalPost.apId)) {
            const targetDomain = extractSwarmDomain(originalPost.apId);
            const originalPostIdOnRemote = extractSwarmPostId(originalPost.apId!);

            const canonicalTarget = targetDomain && originalPostIdOnRemote
                ? `swarm:${targetDomain}:${originalPostIdOnRemote}`
                : null;
            if (targetDomain && originalPostIdOnRemote
                && signedAction?.data?.postId === canonicalTarget) {
                (async () => {
                    try {
                        const { deliverSwarmRepost } = await import('@/lib/swarm/interactions');

                        const result = await deliverSwarmRepost(targetDomain, {
                            userAction: signedAction,
                            postId: originalPostIdOnRemote,
                            repost: {
                                actorHandle: user.handle,
                                actorDisplayName: user.displayName || user.handle,
                                actorAvatarUrl: user.avatarUrl || undefined,
                                actorIsNsfw,
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
        const body = await readOptionalJson(request);
        const signedAction = isSignedActionPayload(body) ? body : null;
        const user = signedAction
            ? await requireSignedAction(signedAction, 'unrepost')
            : await requireAuth();
        const { id: rawId } = await context.params;
        const decodedId = decodeURIComponent(rawId);
        if (signedAction?.data?.postId !== undefined
            && signedAction.data.postId !== decodedId) {
            return NextResponse.json({ error: 'Post ID mismatch' }, { status: 400 });
        }
        let postId = postIdSchema.parse(decodedId);
        const nodeDomain = requireCanonicalAccountHomeDomain(
            process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
        );
        postId = normalizeSameNodePostId(postId, nodeDomain);

        if (user.isSuspended || user.isSilenced) {
            return NextResponse.json({ error: 'Account restricted' }, { status: 403 });
        }

        // Handle swarm posts (format: swarm:domain:uuid)
        if (postId.startsWith('swarm:')) {
            if (!signedAction) {
                return NextResponse.json(
                    { error: 'Remote unreposts require a signed user action' },
                    { status: 428 },
                );
            }
            const parsedSwarmId = parseSwarmPostId(postId);
            if (!parsedSwarmId) {
                return NextResponse.json({ error: 'Invalid swarm post ID' }, { status: 400 });
            }
            const { domain: targetDomain, originalPostId } = parsedSwarmId;
            if (await isNodeBlocked(targetDomain)) {
                await removeLocalSwarmRepost(user.id, targetDomain, originalPostId);
                return NextResponse.json({
                    success: true,
                    reposted: false,
                    localOnly: true,
                    message: 'The repost was removed locally while this node is blocked.',
                });
            }

            // Deliver unrepost directly to the origin node
            const { deliverSwarmUnrepost } = await import('@/lib/swarm/interactions');

            const result = await deliverSwarmUnrepost(targetDomain, {
                userAction: signedAction,
                postId: originalPostId,
                unrepost: {
                    actorHandle: user.handle,
                    actorNodeDomain: nodeDomain,
                    interactionId: crypto.randomUUID(),
                    timestamp: new Date().toISOString(),
                },
            });

            const originBlockedThisNode = !result.success && result.code === NODE_BLOCKED_CODE;
            if (!result.success && !originBlockedThisNode) {
                console.error(`[Swarm] Unrepost delivery failed: ${result.error}`);
                return NextResponse.json({ error: 'Failed to deliver unrepost to remote node' }, { status: 502 });
            }

            await removeLocalSwarmRepost(user.id, targetDomain, originalPostId);

            if (originBlockedThisNode) {
                console.log(`[Swarm] Removed local repost after ${targetDomain} denied federation access`);
            } else {
                console.log(`[Swarm] Unrepost delivered to ${targetDomain} for post ${originalPostId}`);
            }

            return NextResponse.json({ success: true, reposted: false });
        }

        // Local post - check if original post exists
        const originalPost = await db.query.posts.findFirst({
            where: { id: postId },
        });

        // Find the repost by this user
        const repost = await db.query.posts.findFirst({
            where: { AND: [{ userId: user.id }, { repostOfId: postId }, { isRemoved: false }] },
        });

        if (!repost) {
            const legacySameNodeRepost = await db.query.userSwarmReposts.findFirst({
                where: { AND: [{ userId: user.id }, { nodeDomain }, { originalPostId: postId }] },
            });
            if (!legacySameNodeRepost) {
                return NextResponse.json({ success: true, reposted: false });
            }

            await Promise.all([
                db.delete(userSwarmReposts).where(eq(userSwarmReposts.id, legacySameNodeRepost.id)),
                db.delete(remoteReposts).where(and(
                    eq(remoteReposts.postId, postId),
                    eq(remoteReposts.actorHandle, user.handle),
                    eq(remoteReposts.actorNodeDomain, nodeDomain),
                )),
            ]);
            await Promise.all([
                db.update(posts)
                    .set({ repostsCount: sql`max(0, ${posts.repostsCount} - 1)` })
                    .where(eq(posts.id, postId)),
                db.update(users)
                    .set({ postsCount: sql`max(0, ${users.postsCount} - 1)` })
                    .where(eq(users.id, user.id)),
            ]);
            return NextResponse.json({ success: true, reposted: false });
        }

        // Mark repost as removed
        await db.update(posts)
            .set({ isRemoved: true })
            .where(eq(posts.id, repost.id));

        // Update original post's repost count
        if (originalPost) {
            await db.update(posts)
                .set({ repostsCount: sql`max(0, ${posts.repostsCount} - 1)` })
                .where(eq(posts.id, postId));
        }

        // Update user's post count
        await db.update(users)
            .set({ postsCount: sql`max(0, ${users.postsCount} - 1)` })
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
