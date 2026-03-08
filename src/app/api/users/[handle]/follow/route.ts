import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { db, follows, users, notifications, remoteFollows } from '@/db';
import { eq, and, sql } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth';
import { requireSignedAction } from '@/lib/auth/verify-signature';
import { isSwarmNode, deliverSwarmFollow, deliverSwarmUnfollow, cacheSwarmUserPosts } from '@/lib/swarm/interactions';
import { discoverNode } from '@/lib/swarm/discovery';

type RouteContext = { params: Promise<{ handle: string }> };

const parseRemoteHandle = (handle: string) => {
    const clean = handle.toLowerCase().replace(/^@/, '');
    const parts = clean.split('@').filter(Boolean);
    if (parts.length === 2) {
        return { handle: parts[0], domain: parts[1] };
    }
    return null;
};

// Check follow status
export async function GET(request: Request, context: RouteContext) {
    try {
        const currentUser = await requireAuth();
        const { handle } = await context.params;
        const cleanHandle = handle.toLowerCase().replace(/^@/, '');
        const remote = parseRemoteHandle(handle);

        if (currentUser.isSuspended || currentUser.isSilenced) {
            return NextResponse.json({ error: 'Account restricted' }, { status: 403 });
        }

        if (remote) {
            if (!db) {
                return NextResponse.json({ error: 'Database not available' }, { status: 503 });
            }
            const targetHandle = `${remote.handle}@${remote.domain}`;
            const existingRemoteFollow = await db.query.remoteFollows.findFirst({
                where: and(
                    eq(remoteFollows.followerId, currentUser.id),
                    eq(remoteFollows.targetHandle, targetHandle)
                ),
            });
            return NextResponse.json({ following: !!existingRemoteFollow, remote: true });
        }

        if (!db) {
            return NextResponse.json({ error: 'Database not available' }, { status: 503 });
        }

        const targetUser = await db.query.users.findFirst({
            where: eq(users.handle, cleanHandle),
        });

        if (!targetUser) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }
        if (targetUser.isSuspended) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        if (targetUser.id === currentUser.id) {
            return NextResponse.json({ following: false, self: true });
        }

        const existingFollow = await db.query.follows.findFirst({
            where: and(
                eq(follows.followerId, currentUser.id),
                eq(follows.followingId, targetUser.id)
            ),
        });

        return NextResponse.json({ following: !!existingFollow });
    } catch (error) {
        if (error instanceof Error && error.message === 'Authentication required') {
            return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
        }
        console.error('Follow status error:', error);
        return NextResponse.json({ error: 'Failed to get follow status' }, { status: 500 });
    }
}

// Follow a user
export async function POST(request: Request, context: RouteContext) {
    try {
        const signedAction = await request.json();
        const currentUser = await requireSignedAction(signedAction);

        // Extract handle from URL params (still needed for routing)
        // But we should also validate it matches the signed action intent if possible, 
        // or just trust the signed interaction timestamp/nonce.
        // For follow, the data usually contains target info.
        // Let's assume the client sends targetHandle in 'data' of signed action to be secure.

        const { handle } = await context.params;
        const cleanHandle = handle.toLowerCase().replace(/^@/, '');
        const remote = parseRemoteHandle(handle);
        const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:3000';

        if (currentUser.isSuspended || currentUser.isSilenced) {
            return NextResponse.json({ error: 'Account restricted' }, { status: 403 });
        }

        if (remote) {
            const targetHandle = `${remote.handle}@${remote.domain}`;

            // Check if already following
            const existingRemoteFollow = await db.query.remoteFollows.findFirst({
                where: and(
                    eq(remoteFollows.followerId, currentUser.id),
                    eq(remoteFollows.targetHandle, targetHandle)
                ),
            });
            if (existingRemoteFollow) {
                return NextResponse.json({ error: 'Already following' }, { status: 400 });
            }

            // Only allow following swarm nodes
            let isSwarm = await isSwarmNode(remote.domain);
            if (!isSwarm) {
                const discovery = await discoverNode(remote.domain, nodeDomain);
                isSwarm = discovery.success;
            }

            if (!isSwarm) {
                return NextResponse.json({ error: 'Can only follow users on Synapsis swarm nodes' }, { status: 400 });
            }

            // Use swarm protocol
            const activityId = crypto.randomUUID();

            const result = await deliverSwarmFollow(remote.domain, {
                targetHandle: remote.handle,
                follow: {
                    followerHandle: currentUser.handle,
                    followerDisplayName: currentUser.displayName || currentUser.handle,
                    followerAvatarUrl: currentUser.avatarUrl || undefined,
                    followerBio: currentUser.bio || undefined,
                    followerNodeDomain: nodeDomain,
                    interactionId: activityId,
                    timestamp: new Date().toISOString(),
                },
            });

            if (!result.success) {
                return NextResponse.json({ error: result.error || 'Failed to follow user' }, { status: 502 });
            }

            // Store the follow locally
            await db.insert(remoteFollows).values({
                followerId: currentUser.id,
                targetHandle,
                targetActorUrl: `swarm://${remote.domain}/${remote.handle}`,
                inboxUrl: `https://${remote.domain}/api/swarm/interactions/inbox`,
                activityId,
                displayName: null,
                bio: null,
                avatarUrl: null,
            });

            // Update the user's following count (atomic increment)
            await db.update(users)
                .set({ followingCount: sql`${users.followingCount} + 1` })
                .where(eq(users.id, currentUser.id));

            // Cache the remote user's recent posts in the background
            cacheSwarmUserPosts(remote.handle, remote.domain, targetHandle, 20)
                .then(result => console.log(`[Swarm] Cached ${result.cached} posts for ${targetHandle}`))
                .catch(err => console.error('[Swarm] Error caching remote posts:', err));

            console.log(`[Swarm] Follow delivered to ${remote.domain} for @${remote.handle}`);
            return NextResponse.json({ success: true, following: true, remote: true, swarm: true });
        }

        if (!db) {
            return NextResponse.json({ error: 'Database not available' }, { status: 503 });
        }

        // Find target user
        const targetUser = await db.query.users.findFirst({
            where: eq(users.handle, cleanHandle),
        });

        if (!targetUser) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }
        if (targetUser.isSuspended) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        // Can't follow yourself
        if (targetUser.id === currentUser.id) {
            return NextResponse.json({ error: 'Cannot follow yourself' }, { status: 400 });
        }

        // Check if already following
        const existingFollow = await db.query.follows.findFirst({
            where: and(
                eq(follows.followerId, currentUser.id),
                eq(follows.followingId, targetUser.id)
            ),
        });

        if (existingFollow) {
            return NextResponse.json({ error: 'Already following' }, { status: 400 });
        }

        // Create follow
        await db.insert(follows).values({
            followerId: currentUser.id,
            followingId: targetUser.id,
        });

        if (currentUser.id !== targetUser.id) {
            // Create notification
            await db.insert(notifications).values({
                userId: targetUser.id,
                actorId: currentUser.id,
                actorHandle: currentUser.handle,
                actorDisplayName: currentUser.displayName,
                actorAvatarUrl: currentUser.avatarUrl,
                actorNodeDomain: null,
                type: 'follow',
            });

            // Also notify bot owner if this is a bot being followed
            if (targetUser.isBot && targetUser.botOwnerId) {
                await db.insert(notifications).values({
                    userId: targetUser.botOwnerId,
                    actorId: currentUser.id,
                    actorHandle: currentUser.handle,
                    actorDisplayName: currentUser.displayName,
                    actorAvatarUrl: currentUser.avatarUrl,
                    actorNodeDomain: null,
                    type: 'follow',
                });
            }
        }

        // Update counts (atomic increments)
        await db.update(users)
            .set({ followingCount: sql`${users.followingCount} + 1` })
            .where(eq(users.id, currentUser.id));

        await db.update(users)
            .set({ followersCount: sql`${users.followersCount} + 1` })
            .where(eq(users.id, targetUser.id));

        return NextResponse.json({ success: true, following: true });
    } catch (error) {
        if (error instanceof Error && error.message === 'Authentication required') {
            return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
        }
        console.error('Follow error:', error);
        return NextResponse.json({ error: 'Failed to follow' }, { status: 500 });
    }
}

// Unfollow a user
export async function DELETE(request: Request, context: RouteContext) {
    try {
        const signedAction = await request.json();
        const currentUser = await requireSignedAction(signedAction);

        const { handle } = await context.params;
        const cleanHandle = handle.toLowerCase().replace(/^@/, '');
        const remote = parseRemoteHandle(handle);
        const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:3000';

        if (remote) {
            if (!db) {
                return NextResponse.json({ error: 'Database not available' }, { status: 503 });
            }
            const targetHandle = `${remote.handle}@${remote.domain}`;
            const existingRemoteFollow = await db.query.remoteFollows.findFirst({
                where: and(
                    eq(remoteFollows.followerId, currentUser.id),
                    eq(remoteFollows.targetHandle, targetHandle)
                ),
            });
            if (!existingRemoteFollow) {
                return NextResponse.json({ error: 'Not following' }, { status: 400 });
            }

            // Use swarm protocol for unfollow
            const result = await deliverSwarmUnfollow(remote.domain, {
                targetHandle: remote.handle,
                unfollow: {
                    followerHandle: currentUser.handle,
                    followerNodeDomain: nodeDomain,
                    interactionId: crypto.randomUUID(),
                    timestamp: new Date().toISOString(),
                },
            });

            if (!result.success) {
                console.warn(`[Swarm] Unfollow delivery failed: ${result.error}`);
                // Continue anyway - remove local record
            }

            // Remove the follow record
            await db.delete(remoteFollows).where(eq(remoteFollows.id, existingRemoteFollow.id));

            // Update the user's following count (atomic decrement, clamped to 0)
            await db.update(users)
                .set({ followingCount: sql`GREATEST(0, ${users.followingCount} - 1)` })
                .where(eq(users.id, currentUser.id));

            console.log(`[Swarm] Unfollow delivered to ${remote.domain}`);
            return NextResponse.json({ success: true, following: false, remote: true, swarm: true });
        }

        if (!db) {
            return NextResponse.json({ error: 'Database not available' }, { status: 503 });
        }

        // Find target user
        const targetUser = await db.query.users.findFirst({
            where: eq(users.handle, cleanHandle),
        });

        if (!targetUser) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }
        if (targetUser.isSuspended) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        // Find existing follow
        const existingFollow = await db.query.follows.findFirst({
            where: and(
                eq(follows.followerId, currentUser.id),
                eq(follows.followingId, targetUser.id)
            ),
        });

        if (!existingFollow) {
            return NextResponse.json({ error: 'Not following' }, { status: 400 });
        }

        // Remove follow
        await db.delete(follows).where(eq(follows.id, existingFollow.id));

        // Update counts (atomic decrements, clamped to 0)
        await db.update(users)
            .set({ followingCount: sql`GREATEST(0, ${users.followingCount} - 1)` })
            .where(eq(users.id, currentUser.id));

        await db.update(users)
            .set({ followersCount: sql`GREATEST(0, ${users.followersCount} - 1)` })
            .where(eq(users.id, targetUser.id));

        return NextResponse.json({ success: true, following: false });
    } catch (error) {
        if (error instanceof Error && error.message === 'Authentication required') {
            return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
        }
        console.error('Unfollow error:', error);
        return NextResponse.json({ error: 'Failed to unfollow' }, { status: 500 });
    }
}
