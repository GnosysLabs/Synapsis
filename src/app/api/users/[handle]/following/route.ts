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
 * Fetch following list from a remote swarm node
 */
const fetchSwarmFollowing = async (handle: string, domain: string, limit: number) => {
    try {
        const protocol = domain.includes('localhost') ? 'http' : 'https';
        const url = `${protocol}://${domain}/api/swarm/users/${handle}/following?limit=${limit}`;
        const res = await signedFederationRead(url, {
            headers: { 'Accept': 'application/json' },
            timeoutMs: 5_000,
            maxResponseBytes: 256 * 1024,
        });
        if (res.status < 200 || res.status >= 300) return null;
        return res.json() as { following?: RemoteUserSummary[] };
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
                    { following: [], nextCursor: null, restricted: true, error: SENSITIVE_REMOTE_PROFILE_MESSAGE },
                    { status: 403 },
                );
            }

            // Fetch from remote swarm node
            const swarmData = await fetchSwarmFollowing(remote.handle, remote.domain, limit);
            if (swarmData?.following) {
                // Transform to include full handles for local users on that node
                const following = swarmData.following.map((f) => ({
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
                const hydratedFollowing = await hydrateSwarmUsers(following);
                const { canViewSensitive } = await getSensitiveContentViewerAccess();
                return NextResponse.json({
                    following: hydratedFollowing.map((userSummary) => (
                        redactSensitiveUserSummary(userSummary, canViewSensitive)
                    )),
                    nextCursor: null,
                });
            }
            // If swarm fetch fails, return empty
            return NextResponse.json({ following: [], nextCursor: null });
        }

        // Return empty if no database
        if (!db) {
            return NextResponse.json({ following: [], nextCursor: null });
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
                { following: [], nextCursor: null, restricted: true, error: SENSITIVE_PROFILE_MESSAGE },
                { status: 403 },
            );
        }

        // Get local following
        const userFollowing = await db
            .select({
                id: follows.id,
                following: users,
            })
            .from(follows)
            .innerJoin(users, eq(follows.followingId, users.id))
            .where(eq(follows.followerId, user.id))
            .limit(limit);

        const localFollowing = userFollowing.map(f => ({
            id: f.following.id,
            handle: f.following.handle,
            displayName: f.following.displayName,
            avatarUrl: f.following.avatarUrl,
            bio: f.following.bio,
            isRemote: false,
            isNsfw: f.following.isNsfw,
            nodeIsNsfw: profileAccess.nodeIsNsfw,
        }));

        // Get remote following
        const userRemoteFollowing = await db.query.remoteFollows.findMany({
            where: { followerId: user.id },
            limit,
        });

        const remoteFollowing = userRemoteFollowing.map(f => ({
            id: f.targetActorUrl,
            handle: f.targetHandle,
            displayName: f.displayName || f.targetHandle.split('@')[0], // Use stored display name or username part
            avatarUrl: f.avatarUrl,
            bio: f.bio,
            isRemote: true,
            nodeDomain: f.targetHandle.split('@').pop(),
        }));

        // Merge and return
        const allFollowing = [...localFollowing, ...remoteFollowing].slice(0, limit);

        // Hydrate remote users with fresh data from swarm
        const hydratedFollowing = await hydrateSwarmUsers(allFollowing);
        const { canViewSensitive } = await getSensitiveContentViewerAccess();

        return NextResponse.json({
            following: hydratedFollowing.map((userSummary) => (
                redactSensitiveUserSummary(userSummary, canViewSensitive)
            )),
            nextCursor: allFollowing.length === limit ? allFollowing[allFollowing.length - 1]?.id : null,
        });
    } catch (error) {
        console.error('Get following error:', error);
        return NextResponse.json({ error: 'Failed to get following' }, { status: 500 });
    }
}
