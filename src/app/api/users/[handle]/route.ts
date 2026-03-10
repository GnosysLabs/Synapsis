import { NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { getSession } from '@/lib/auth';
import { db, users, follows } from '@/db';
import { fetchSwarmUserProfile, isSwarmNode } from '@/lib/swarm/interactions';
import { discoverNode } from '@/lib/swarm/discovery';

type RouteContext = { params: Promise<{ handle: string }> };

export async function GET(request: Request, context: RouteContext) {
    try {
        const { handle } = await context.params;
        const cleanHandle = handle.toLowerCase().replace(/^@/, '');
        const [remoteHandle, remoteDomain] = cleanHandle.split('@');

        // Return mock user if no database
        if (!db) {
            return NextResponse.json({
                user: {
                    id: 'demo-user',
                    handle: cleanHandle,
                    displayName: cleanHandle,
                    bio: 'This is a demo profile.',
                    avatarUrl: null,
                    headerUrl: null,
                    followersCount: 0,
                    followingCount: 0,
                    postsCount: 0,
                    createdAt: new Date().toISOString(),
                }
            });
        }

        const user = await db.query.users.findFirst({
            where: eq(users.handle, cleanHandle),
        });

        // If user exists but is a remote placeholder (handle contains @), fetch fresh data from remote
        const isRemotePlaceholder = user && cleanHandle.includes('@');

        if (!user || isRemotePlaceholder) {
            if (remoteHandle && remoteDomain) {
                // Only fetch from swarm nodes
                let isSwarm = await isSwarmNode(remoteDomain);
                if (!isSwarm) {
                    const discovery = await discoverNode(remoteDomain);
                    isSwarm = discovery.success;
                }

                if (isSwarm) {
                    const profileData = await fetchSwarmUserProfile(remoteHandle, remoteDomain, 0);
                    if (profileData?.profile) {
                        const profile = profileData.profile;
                        const rawBotOwnerHandle = profile.botOwnerHandle?.toLowerCase().replace(/^@/, '') || null;
                        const normalizedBotOwnerHandle = rawBotOwnerHandle
                            ? rawBotOwnerHandle.includes('@')
                                ? rawBotOwnerHandle
                                : `${rawBotOwnerHandle}@${remoteDomain}`
                            : null;
                        const botOwnerLocalHandle = rawBotOwnerHandle
                            ? rawBotOwnerHandle.split('@')[0]
                            : null;

                        // CACHE: Upsert the remote user into our local database
                        const { upsertRemoteUser } = await import('@/lib/swarm/user-cache');
                        await upsertRemoteUser({
                            handle: `${profile.handle}@${remoteDomain}`,
                            displayName: profile.displayName,
                            avatarUrl: profile.avatarUrl || null,
                            did: profile.did || '',
                            isBot: profile.isBot || false,
                            publicKey: profile.publicKey,
                        });

                        return NextResponse.json({
                            user: {
                                id: `swarm:${remoteDomain}:${profile.handle}`,
                                handle: `${profile.handle}@${remoteDomain}`,
                                displayName: profile.displayName,
                                bio: profile.bio || null,
                                avatarUrl: profile.avatarUrl || null,
                                headerUrl: profile.headerUrl || null,
                                followersCount: profile.followersCount,
                                followingCount: profile.followingCount,
                                postsCount: profile.postsCount,
                                website: profile.website || null,
                                createdAt: profile.createdAt,
                                isRemote: true,
                                isSwarm: true,
                                nodeDomain: remoteDomain,
                                isBot: profile.isBot || false,
                                botOwner: normalizedBotOwnerHandle && botOwnerLocalHandle ? {
                                    id: `swarm:${remoteDomain}:${botOwnerLocalHandle}`,
                                    handle: normalizedBotOwnerHandle,
                                    displayName: botOwnerLocalHandle,
                                    avatarUrl: null,
                                } : null,
                                did: profile.did,
                            }
                        });
                    }
                }

                // Non-swarm nodes are no longer supported
                return NextResponse.json({ error: 'User not found. Only Synapsis swarm nodes are supported.' }, { status: 404 });
            }
            // Only return 404 if this wasn't a remote placeholder we were trying to refresh
            if (!isRemotePlaceholder) {
                return NextResponse.json({ error: 'User not found' }, { status: 404 });
            }
        }
        if (user.isSuspended) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        // Return user profile (without sensitive data)
        const userResponse: Record<string, unknown> = {
            id: user.id,
            handle: user.handle,
            displayName: user.displayName,
            bio: user.bio,
            avatarUrl: user.avatarUrl,
            headerUrl: user.headerUrl,
            followersCount: user.followersCount,
            followingCount: user.followingCount,
            postsCount: user.postsCount,
            createdAt: user.createdAt,
            website: user.website,
            movedTo: user.movedTo,
            isBot: user.isBot,
            publicKey: user.publicKey, // Signing key
            did: user.did, // V2 Identity
            dmPrivacy: user.dmPrivacy,
        };

        // Check if viewer can DM this user
        let canReceiveDms = true;
        if (user.isBot) {
            canReceiveDms = false;
        } else if (user.dmPrivacy === 'none') {
            canReceiveDms = false;
        } else if (user.dmPrivacy === 'following') {
            canReceiveDms = false; // Default to false for 'following'
            const session = await getSession();
            if (session?.user) {
                if (session.user.id === user.id) {
                    canReceiveDms = true; // Can DM yourself
                } else {
                    const isFollowingViewer = await db.query.follows.findFirst({
                        where: and(
                            eq(follows.followerId, user.id),
                            eq(follows.followingId, session.user.id)
                        )
                    });
                    if (isFollowingViewer) {
                        canReceiveDms = true;
                    }
                }
            }
        }
        userResponse.canReceiveDms = canReceiveDms;

        // If this is a bot, include owner info
        if (user.isBot && user.botOwnerId) {
            const owner = await db.query.users.findFirst({
                where: eq(users.id, user.botOwnerId),
            });
            if (owner) {
                userResponse.botOwner = {
                    id: owner.id,
                    handle: owner.handle,
                    displayName: owner.displayName,
                    avatarUrl: owner.avatarUrl,
                };
            }
        }

        return NextResponse.json({ user: userResponse });
    } catch (error) {
        console.error('Get user error:', error);
        return NextResponse.json({ error: 'Failed to get user' }, { status: 500 });
    }
}
