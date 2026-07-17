import { NextResponse } from 'next/server';
import { db, follows, users } from '@/db';
import { eq } from 'drizzle-orm';
import { hydrateSwarmUsers } from '@/lib/swarm/user-hydration';
import { resolveUserHandle } from '@/lib/swarm/user-handle';
import { fetchSwarmUserProfile } from '@/lib/swarm/interactions';
import {
    canCurrentViewerAccessSensitiveRemoteProfile,
    getCurrentViewerSensitiveProfileAccess,
    SENSITIVE_PROFILE_MESSAGE,
    SENSITIVE_REMOTE_PROFILE_MESSAGE,
} from '@/lib/nsfw/remote-profile-access';
import { getSensitiveContentViewerAccess } from '@/lib/nsfw/viewer-access';
import { redactSensitiveUserSummary } from '@/lib/nsfw/content-visibility';
import { signedFederationRead } from '@/lib/swarm/signed-read';

type RouteContext = { params: Promise<{ handle: string }> };
type RemoteUserSummary = {
    handle: string;
    displayName?: string;
    avatarUrl?: string;
    bio?: string;
    isRemote?: boolean;
    isNsfw?: boolean;
    nodeIsNsfw?: boolean;
    nodeDomain?: string;
};

/**
 * Fetch followers list from a remote swarm node
 */
const fetchSwarmFollowers = async (handle: string, domain: string, limit: number) => {
    try {
        const protocol = domain.includes('localhost') ? 'http' : 'https';
        const url = `${protocol}://${domain}/api/swarm/users/${handle}/followers?limit=${limit}`;
        const res = await signedFederationRead(url, {
            headers: { 'Accept': 'application/json' },
            timeoutMs: 5_000,
            maxResponseBytes: 256 * 1024,
        });
        if (res.status < 200 || res.status >= 300) return null;
        return res.json() as { followers?: RemoteUserSummary[] };
    } catch {
        return null;
    }
};

export async function GET(request: Request, context: RouteContext) {
    try {
        const { handle } = await context.params;
        const resolvedHandle = resolveUserHandle(handle);
        const cleanHandle = resolvedHandle.canonicalHandle;
        const { searchParams } = new URL(request.url);
        const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 50);

        // Check if this is a remote user
        const remote = resolvedHandle.remote;

        if (remote) {
            const profileData = await fetchSwarmUserProfile(remote.handle, remote.domain, 0);
            if (!await canCurrentViewerAccessSensitiveRemoteProfile({
                accountIsNsfw: profileData?.profile.isNsfw,
                nodeIsNsfw: profileData?.profile.nodeIsNsfw,
            })) {
                return NextResponse.json(
                    { followers: [], nextCursor: null, restricted: true, error: SENSITIVE_REMOTE_PROFILE_MESSAGE },
                    { status: 403 },
                );
            }

            // Fetch from remote swarm node
            const swarmData = await fetchSwarmFollowers(remote.handle, remote.domain, limit);
            if (swarmData?.followers) {
                // Transform to include full handles for local users on that node
                const followers = swarmData.followers.map((f) => ({
                    id: f.isRemote ? f.handle : `${f.handle}@${remote.domain}`,
                    handle: f.isRemote ? f.handle : `${f.handle}@${remote.domain}`,
                    displayName: f.displayName,
                    avatarUrl: f.avatarUrl,
                    bio: f.bio,
                    isRemote: true,
                    isNsfw: f.isNsfw,
                    nodeIsNsfw: f.nodeIsNsfw,
                    nodeDomain: f.nodeDomain || remote.domain,
                }));
                const hydratedFollowers = await hydrateSwarmUsers(followers);
                const { canViewSensitive } = await getSensitiveContentViewerAccess();
                return NextResponse.json({
                    followers: hydratedFollowers.map((follower) => (
                        redactSensitiveUserSummary(follower, canViewSensitive)
                    )),
                    nextCursor: null,
                });
            }
            // If swarm fetch fails, return empty
            return NextResponse.json({ followers: [], nextCursor: null });
        }

        // Return empty if no database
        if (!db) {
            return NextResponse.json({ followers: [], nextCursor: null });
        }

        // Find the user
        const user = await db.query.users.findFirst({
            where: { handle: cleanHandle },
        });

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
            return NextResponse.json(
                { followers: [], nextCursor: null, restricted: true, error: SENSITIVE_PROFILE_MESSAGE },
                { status: 403 },
            );
        }

        // Get followers
        const userFollowers = await db
            .select({
                id: follows.id,
                follower: users,
            })
            .from(follows)
            .innerJoin(users, eq(follows.followerId, users.id))
            .where(eq(follows.followingId, user.id))
            .limit(limit);

        const localFollowers = userFollowers.map(f => ({
            id: f.follower.id,
            handle: f.follower.handle,
            displayName: f.follower.displayName,
            avatarUrl: f.follower.avatarUrl,
            bio: f.follower.bio,
            isRemote: false,
            isNsfw: f.follower.isNsfw,
            nodeIsNsfw: profileAccess.nodeIsNsfw,
        }));

        // Get remote followers
        const userRemoteFollowers = await db.query.remoteFollowers.findMany({
            where: { userId: user.id },
            limit,
        });

        const remoteFollowersList = userRemoteFollowers.map(f => ({
            id: f.actorUrl,
            handle: f.handle || 'unknown',
            displayName: f.handle?.split('@')[0] || 'Unknown',
            avatarUrl: null,
            bio: null,
            isRemote: true,
            nodeDomain: f.handle?.split('@').pop(),
        }));

        // Merge and return
        const allFollowers = [...localFollowers, ...remoteFollowersList].slice(0, limit);

        // Hydrate users with fresh data from swarm
        const hydratedFollowers = await hydrateSwarmUsers(allFollowers);
        const { canViewSensitive } = await getSensitiveContentViewerAccess();

        return NextResponse.json({
            followers: hydratedFollowers.map((follower) => (
                redactSensitiveUserSummary(follower, canViewSensitive)
            )),
            nextCursor: userFollowers.length === limit ? userFollowers[userFollowers.length - 1]?.id : null,
        });
    } catch (error) {
        console.error('Get followers error:', error);
        return NextResponse.json({ error: 'Failed to get followers' }, { status: 500 });
    }
}
