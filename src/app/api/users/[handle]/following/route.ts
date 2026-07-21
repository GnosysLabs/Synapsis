import { NextResponse } from 'next/server';
import { db, follows, users } from '@/db';
import { and, eq } from 'drizzle-orm';
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
import { parseBoundedInteger } from '@/lib/http/query';
import { parseAccountAddress } from '@/lib/identity/account-address';
import {
    canonicalizeRemoteUserListDomain,
    isValidRemoteUserListHandle,
    parseRemoteUserListResponse,
    type ParsedRemoteUserListEntry,
} from '@/lib/swarm/remote-user-list-payload';

type RouteContext = { params: Promise<{ handle: string }> };

function publicUserSummary(entry: ParsedRemoteUserListEntry) {
    return {
        id: entry.id,
        handle: entry.handle,
        displayName: entry.displayName,
        avatarUrl: entry.avatarUrl,
        bio: entry.bio,
        isRemote: entry.isRemote,
        isNsfw: entry.isNsfw,
        nodeIsNsfw: entry.nodeIsNsfw,
        nodeDomain: entry.nodeDomain,
    };
}

/**
 * Fetch following list from a remote swarm node
 */
const fetchSwarmFollowing = async (handle: string, domain: string, limit: number) => {
    try {
        const canonicalDomain = canonicalizeRemoteUserListDomain(domain);
        if (!canonicalDomain || !isValidRemoteUserListHandle(handle)) return null;
        const isDevelopmentLoopback = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i
            .test(canonicalDomain);
        const protocol = isDevelopmentLoopback ? 'http' : 'https';
        const url = new URL(
            `/api/swarm/users/${encodeURIComponent(handle)}/following`,
            `${protocol}://${canonicalDomain}`,
        );
        url.searchParams.set('limit', String(limit));
        const res = await signedFederationRead(url.toString(), {
            headers: { 'Accept': 'application/json' },
            timeoutMs: 5_000,
            maxResponseBytes: 256 * 1024,
        });
        if (res.status < 200 || res.status >= 300) return null;
        return parseRemoteUserListResponse(res.json(), canonicalDomain, 'following', limit);
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
        const limit = parseBoundedInteger(searchParams.get('limit'), {
            defaultValue: 20,
            min: 1,
            max: 50,
        });

        // Check if this is a remote user
        const remote = resolvedHandle.remote;

        if (remote) {
            const remoteDomain = canonicalizeRemoteUserListDomain(remote.domain);
            if (!remoteDomain || !isValidRemoteUserListHandle(remote.handle)) {
                return NextResponse.json({ following: [], nextCursor: null });
            }
            const profileData = await fetchSwarmUserProfile(remote.handle, remoteDomain, 0);
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
            const swarmFollowing = await fetchSwarmFollowing(remote.handle, remoteDomain, limit);
            if (swarmFollowing) {
                // A contacted peer may summarize third-party accounts, but it cannot
                // nominate those domains as profile-hydration fetch targets.
                const hydrationCandidates = swarmFollowing
                    .filter((entry) => entry.isSourceOwned)
                    .map(publicUserSummary);
                const hydratedFollowing = hydrationCandidates.length > 0
                    ? await hydrateSwarmUsers(hydrationCandidates)
                    : [];
                const hydratedById = new Map(hydratedFollowing.map((entry) => [entry.id, entry]));
                const following = swarmFollowing.map((entry) => {
                    const summary = publicUserSummary(entry);
                    return entry.isSourceOwned ? hydratedById.get(entry.id) ?? summary : summary;
                });
                const { canViewSensitive } = await getSensitiveContentViewerAccess();
                return NextResponse.json({
                    following: following.map((userSummary) => (
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
            where: { AND: [{ handle: cleanHandle }, { isLocalAccount: true }] },
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
            .where(and(
                eq(follows.followerId, user.id),
                eq(users.isLocalAccount, true),
            ))
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

        const remoteFollowing = userRemoteFollowing.flatMap((f) => {
            const address = parseAccountAddress(f.targetHandle);
            if (!address) return [];
            return [{
                id: f.targetActorUrl,
                handle: address.canonical,
                displayName: f.displayName || address.username,
                avatarUrl: f.avatarUrl,
                bio: f.bio,
                isRemote: true,
                nodeDomain: address.homeDomain,
            }];
        });

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
