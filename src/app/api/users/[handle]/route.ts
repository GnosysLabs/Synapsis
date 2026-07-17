import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db } from '@/db';
import { fetchSwarmUserProfile, isSwarmNode } from '@/lib/swarm/interactions';
import { discoverNode } from '@/lib/swarm/discovery';
import { resolveUserHandle } from '@/lib/swarm/user-handle';
import {
    canCurrentViewerAccessSensitiveRemoteProfile,
    getCurrentViewerSensitiveProfileAccess,
} from '@/lib/nsfw/remote-profile-access';

type RouteContext = { params: Promise<{ handle: string }> };

export async function GET(request: Request, context: RouteContext) {
    try {
        const { handle } = await context.params;
        const resolvedHandle = resolveUserHandle(handle);
        const cleanHandle = resolvedHandle.canonicalHandle;
        const remote = resolvedHandle.remote;

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
            where: { handle: cleanHandle },
        });

        // If user exists but is a remote placeholder (handle contains @), fetch fresh data from remote
        const isRemotePlaceholder = Boolean(user && remote);

        if (!user || isRemotePlaceholder) {
            if (remote) {
                // Only fetch from swarm nodes
                let isSwarm = await isSwarmNode(remote.domain);
                if (!isSwarm) {
                    const discovery = await discoverNode(remote.domain);
                    isSwarm = discovery.success;
                }

                if (isSwarm) {
                    const profileData = await fetchSwarmUserProfile(remote.handle, remote.domain, 0);
                    if (profileData?.profile) {
                        const profile = profileData.profile;
                        const canAccessProfile = await canCurrentViewerAccessSensitiveRemoteProfile({
                            accountIsNsfw: profile.isNsfw,
                            nodeIsNsfw: profile.nodeIsNsfw,
                        });
                        // CACHE: Upsert the remote user into our local database
                        const { upsertRemoteUser } = await import('@/lib/swarm/user-cache');
                        await upsertRemoteUser({
                            handle: `${profile.handle}@${remote.domain}`,
                            displayName: profile.displayName,
                            avatarUrl: profile.avatarUrl || null,
                            did: profile.did || '',
                            publicKey: profile.publicKey,
                            isNsfw: profile.isNsfw,
                        });

                        return NextResponse.json({
                            user: {
                                id: `swarm:${remote.domain}:${profile.handle}`,
                                handle: `${profile.handle}@${remote.domain}`,
                                displayName: canAccessProfile ? profile.displayName : profile.handle,
                                bio: canAccessProfile ? profile.bio || null : null,
                                avatarUrl: canAccessProfile ? profile.avatarUrl || null : null,
                                headerUrl: canAccessProfile ? profile.headerUrl || null : null,
                                followersCount: profile.followersCount,
                                followingCount: profile.followingCount,
                                postsCount: profile.postsCount,
                                website: canAccessProfile ? profile.website || null : null,
                                createdAt: profile.createdAt,
                                isRemote: true,
                                isSwarm: true,
                                nodeDomain: remote.domain,
                                did: profile.did,
                                publicKey: profile.publicKey,
                                isNsfw: profile.isNsfw,
                                nodeIsNsfw: profile.nodeIsNsfw,
                                nsfwRestricted: !canAccessProfile,
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
        if (!user) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }
        if (user.isSuspended) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        const profileAccess = await getCurrentViewerSensitiveProfileAccess({
            accountIsNsfw: user.isNsfw,
        });
        if (!profileAccess.allowed) {
            return NextResponse.json({
                user: {
                    id: user.id,
                    handle: user.handle,
                    displayName: user.handle,
                    bio: null,
                    avatarUrl: null,
                    headerUrl: null,
                    followersCount: user.followersCount,
                    followingCount: user.followingCount,
                    postsCount: user.postsCount,
                    website: null,
                    createdAt: user.createdAt,
                    did: user.did,
                    publicKey: user.publicKey,
                    isNsfw: user.isNsfw,
                    nodeIsNsfw: profileAccess.nodeIsNsfw,
                    nsfwRestricted: true,
                },
            });
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
            publicKey: user.publicKey, // Signing key
            did: user.did, // V2 Identity
            dmPrivacy: user.dmPrivacy,
            isNsfw: user.isNsfw,
            nodeIsNsfw: profileAccess.nodeIsNsfw,
        };

        // Check if viewer can DM this user
        let canReceiveDms = true;
        if (user.dmPrivacy === 'none') {
            canReceiveDms = false;
        } else if (user.dmPrivacy === 'following') {
            canReceiveDms = false; // Default to false for 'following'
            const session = await getSession();
            if (session?.user) {
                if (session.user.id === user.id) {
                    canReceiveDms = true; // Can DM yourself
                } else {
                    const isFollowingViewer = await db.query.follows.findFirst({
                        where: { AND: [{ followerId: user.id }, { followingId: session.user.id }] }
                    });
                    if (isFollowingViewer) {
                        canReceiveDms = true;
                    }
                }
            }
        }
        userResponse.canReceiveDms = canReceiveDms;

        return NextResponse.json({ user: userResponse });
    } catch (error) {
        console.error('Get user error:', error);
        return NextResponse.json({ error: 'Failed to get user' }, { status: 500 });
    }
}
