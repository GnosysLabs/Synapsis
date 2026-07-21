import { NextResponse } from 'next/server';
import { db, follows, remoteFollowers, users } from '@/db';
import { and, eq, isNull, notInArray } from 'drizzle-orm';
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
import { getBlockedNodeDomains } from '@/lib/swarm/node-blocklist';
import {
    canonicalizeRemoteUserListDomain,
    isValidRemoteUserListHandle,
    parseRemoteUserListResponse,
    type ParsedRemoteUserListEntry,
} from '@/lib/swarm/remote-user-list-payload';
import { stuffboxBadgeFromStoredUser } from '@/lib/stuffbox/badge';

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
 * Fetch followers list from a remote swarm node
 */
const fetchSwarmFollowers = async (handle: string, domain: string, limit: number) => {
    try {
        const canonicalDomain = canonicalizeRemoteUserListDomain(domain);
        if (!canonicalDomain || !isValidRemoteUserListHandle(handle)) return null;
        const isDevelopmentLoopback = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i
            .test(canonicalDomain);
        const protocol = isDevelopmentLoopback ? 'http' : 'https';
        const url = new URL(
            `/api/swarm/users/${encodeURIComponent(handle)}/followers`,
            `${protocol}://${canonicalDomain}`,
        );
        url.searchParams.set('limit', String(limit));
        const res = await signedFederationRead(url.toString(), {
            headers: { 'Accept': 'application/json' },
            timeoutMs: 5_000,
            maxResponseBytes: 256 * 1024,
        });
        if (res.status < 200 || res.status >= 300) return null;
        return parseRemoteUserListResponse(res.json(), canonicalDomain, 'followers', limit);
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
                return NextResponse.json({ followers: [], nextCursor: null });
            }
            const profileData = await fetchSwarmUserProfile(remote.handle, remoteDomain, 0);
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
            const swarmFollowers = await fetchSwarmFollowers(remote.handle, remoteDomain, limit);
            if (swarmFollowers) {
                // A contacted peer may summarize third-party accounts, but it cannot
                // nominate those domains as profile-hydration fetch targets.
                const hydrationCandidates = swarmFollowers
                    .filter((entry) => entry.isSourceOwned)
                    .map(publicUserSummary);
                const hydratedFollowers = hydrationCandidates.length > 0
                    ? await hydrateSwarmUsers(hydrationCandidates)
                    : [];
                const hydratedById = new Map(hydratedFollowers.map((entry) => [entry.id, entry]));
                const followers = swarmFollowers.map((entry) => {
                    const summary = publicUserSummary(entry);
                    return entry.isSourceOwned ? hydratedById.get(entry.id) ?? summary : summary;
                });
                const { canViewSensitive } = await getSensitiveContentViewerAccess();
                return NextResponse.json({
                    followers: followers.map((follower) => (
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
            .where(and(
                eq(follows.followingId, user.id),
                eq(users.isLocalAccount, true),
            ))
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
            stuffboxBadge: stuffboxBadgeFromStoredUser(f.follower),
        }));

        // Get remote followers
        const blockedNodeDomains = Array.from(await getBlockedNodeDomains());
        const userRemoteFollowers = await db.select().from(remoteFollowers).where(and(
            eq(remoteFollowers.userId, user.id),
            isNull(remoteFollowers.suspendedAt),
            ...(blockedNodeDomains.length > 0
                ? [notInArray(remoteFollowers.actorNodeDomain, blockedNodeDomains)]
                : []),
        )).limit(limit);

        const remoteFollowersList = userRemoteFollowers.flatMap((f) => {
            const address = f.handle ? parseAccountAddress(f.handle) : null;
            if (!address) return [];
            return [{
                id: f.actorUrl,
                handle: address.canonical,
                displayName: address.username,
                avatarUrl: null,
                bio: null,
                isRemote: true,
                nodeDomain: address.homeDomain,
            }];
        });

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
