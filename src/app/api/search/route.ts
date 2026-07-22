import { NextResponse } from 'next/server';
import { db, follows, mutedNodes, users, posts, remoteFollows } from '@/db';
import { like, or, and, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { fetchSwarmUserProfile, isSwarmNode } from '@/lib/swarm/interactions';
import { probeTransientNode } from '@/lib/swarm/transient-node-probe';
import type { SwarmDirectoryUser } from '@/lib/swarm/user-directory';
import { searchKnownSwarmUsers } from '@/lib/swarm/user-directory-search';
import { getCachedSwarmTimeline } from '@/lib/swarm/content-cache';
import { mapSwarmPostToPost } from '@/lib/swarm/feed-post';
import { canCurrentViewerAccessSensitiveRemoteProfile } from '@/lib/nsfw/remote-profile-access';
import { getSensitiveContentViewerAccess } from '@/lib/nsfw/viewer-access';
import {
    isPostSensitive,
    redactSensitivePostForViewer,
    redactSensitiveUserSummary,
} from '@/lib/nsfw/content-visibility';
import { parseBoundedInteger } from '@/lib/http/query';
import { searchIndexedPostIds } from '@/lib/search/post-index';
import {
    canonicalAccountHomeDomain,
    parseAccountAddress,
    requireCanonicalAccountHomeDomain,
} from '@/lib/identity/account-address';
import { getBlockedNodeDomains } from '@/lib/swarm/node-blocklist';
import {
    attachStoredStuffboxBadgesToPost,
    stuffboxBadgeFromStoredUser,
} from '@/lib/stuffbox/badge';
import type { StuffboxBadge } from '@/lib/types';

const embeddedPostRelations = {
    author: true,
    media: true,
    replyTo: {
        with: {
            author: true,
            media: true,
        },
    },
} as const;

const searchPostRelations = {
    ...embeddedPostRelations,
    repostOf: {
        with: embeddedPostRelations,
    },
} as const;

type SearchUser = {
    id: string;
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    bio: string | null;
    profileUrl?: string | null;
    isRemote?: boolean;
    isNsfw?: boolean;
    nodeIsNsfw?: boolean;
    nodeDomain?: string | null;
    isFollowing?: boolean;
    stuffboxBadge?: StuffboxBadge | null;
};

const SEARCH_SWARM_TIMEOUT_MS = 1_500;

function mergeSearchUsers(local: SearchUser[], remote: SearchUser[], limit: number): SearchUser[] {
    const seen = new Set<string>();
    const localQueue = local.filter((user) => {
        const handle = user.handle.toLowerCase();
        if (seen.has(handle)) return false;
        seen.add(handle);
        return true;
    });
    const remoteQueue = remote.filter((user) => {
        const handle = user.handle.toLowerCase();
        if (seen.has(handle)) return false;
        seen.add(handle);
        return true;
    });
    const merged: SearchUser[] = [];
    let localIndex = 0;
    let remoteIndex = 0;
    while (merged.length < limit && (localIndex < localQueue.length || remoteIndex < remoteQueue.length)) {
        if (localIndex < localQueue.length) merged.push(localQueue[localIndex++]);
        if (merged.length < limit && remoteIndex < remoteQueue.length) merged.push(remoteQueue[remoteIndex++]);
    }
    return merged;
}

function toSearchUser(user: SwarmDirectoryUser): SearchUser {
    const address = parseAccountAddress(user.handle);
    const nodeDomain = canonicalAccountHomeDomain(user.nodeDomain);
    if (!address || !nodeDomain || address.homeDomain !== nodeDomain) {
        throw new Error('Search directory returned an invalid account address');
    }
    return {
        id: `swarm:${nodeDomain}:${address.username}`,
        handle: address.canonical,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        bio: null,
        profileUrl: `https://${nodeDomain}/@${address.username}`,
        isRemote: true,
        isNsfw: user.isNsfw,
        nodeIsNsfw: user.nodeIsNsfw,
        nodeDomain,
        stuffboxBadge: user.stuffboxBadge,
    };
}

const parseRemoteHandleQuery = (query: string): { handle: string; domain: string } | null => {
    let trimmed = query.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('acct:')) {
        trimmed = trimmed.slice(5);
    }
    const withoutPrefix = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
    if (withoutPrefix.includes(' ')) return null;
    const parts = withoutPrefix.split('@').filter(Boolean);
    if (parts.length !== 2) return null;
    const [handle, domain] = parts;
    if (!handle || !domain) return null;
    if (!domain.includes('.') && !domain.includes(':')) return null;
    return { handle: handle.toLowerCase(), domain: domain.toLowerCase() };
};

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const query = searchParams.get('q') || '';
        const type = searchParams.get('type') || 'all'; // all, users, posts
        const limit = parseBoundedInteger(searchParams.get('limit'), {
            defaultValue: 20,
            min: 1,
            max: 50,
        });

        if (!query.trim()) {
            return NextResponse.json({ users: [], posts: [] });
        }

        // Return empty if no database
        if (!db) {
            return NextResponse.json({
                users: [],
                posts: [],
                message: 'Search requires database connection'
            });
        }
        const { viewer, localNodeIsNsfw, canViewSensitive } = await getSensitiveContentViewerAccess();
        if (localNodeIsNsfw && !viewer) {
            return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
        }
        const mutedNodeRows = viewer
            ? await db.select({ nodeDomain: mutedNodes.nodeDomain })
                .from(mutedNodes)
                .where(eq(mutedNodes.userId, viewer.id))
            : [];
        const mutedDomains = new Set(mutedNodeRows.flatMap((row) => {
            const domain = canonicalAccountHomeDomain(row.nodeDomain);
            return domain ? [domain] : [];
        }));

        // Normalize query for local user search
        // Strip leading @ and local domain if present
        let localSearchQuery = query.trim();
        if (localSearchQuery.startsWith('@')) {
            localSearchQuery = localSearchQuery.slice(1);
        }
        // Remove local domain if searching like "admin2@dev.syn.quest"
        const localDomain = requireCanonicalAccountHomeDomain(
            process.env.NEXT_PUBLIC_NODE_DOMAIN || process.env.NODE_DOMAIN || 'localhost:43821',
        );
        if (localDomain && localSearchQuery.includes('@')) {
            const parts = localSearchQuery.split('@');
            if (canonicalAccountHomeDomain(parts[1]) === localDomain) {
                localSearchQuery = parts[0];
            }
        }

        const isHandleSearch = query.trim().startsWith('@');
        const searchPattern = `%${localSearchQuery}%`;
        let searchUsers: SearchUser[] = [];
        let searchPosts: typeof posts.$inferSelect[] = [];

        // Search users
        if (type === 'all' || type === 'users') {
            if (isHandleSearch) {
                // Try exact match first
                const exactMatch = await db.select({
                    id: users.id,
                    handle: users.handle,
                    displayName: users.displayName,
                    avatarUrl: users.avatarUrl,
                    bio: users.bio,
                    isNsfw: users.isNsfw,
                    stuffboxBadgeProof: users.stuffboxBadgeProof,
                    stuffboxBadgeLevel: users.stuffboxBadgeLevel,
                    stuffboxBadgePlan: users.stuffboxBadgePlan,
                    stuffboxBadgeIssuer: users.stuffboxBadgeIssuer,
                    stuffboxBadgeExpiresAt: users.stuffboxBadgeExpiresAt,
                })
                    .from(users)
                    .where(and(
                        eq(users.username, localSearchQuery.toLowerCase()),
                        eq(users.homeDomain, localDomain),
                        eq(users.isLocalAccount, true),
                        eq(users.isSuspended, false),
                        eq(users.isSilenced, false)
                    ))
                    .limit(1);

                if (exactMatch.length > 0) {
                    searchUsers = exactMatch.map((user) => ({
                        ...user,
                        stuffboxBadge: stuffboxBadgeFromStoredUser(user),
                    }));
                }
            }

            if (searchUsers.length === 0) {
                const userConditions = and(
                    or(
                        like(users.username, searchPattern),
                        like(users.displayName, searchPattern),
                        like(users.bio, searchPattern)
                    ),
                    eq(users.homeDomain, localDomain),
                    eq(users.isLocalAccount, true),
                    eq(users.isSuspended, false),
                    eq(users.isSilenced, false)
                );
                const localUsers = await db.select({
                    id: users.id,
                    handle: users.handle,
                    displayName: users.displayName,
                    avatarUrl: users.avatarUrl,
                    bio: users.bio,
                    isNsfw: users.isNsfw,
                    stuffboxBadgeProof: users.stuffboxBadgeProof,
                    stuffboxBadgeLevel: users.stuffboxBadgeLevel,
                    stuffboxBadgePlan: users.stuffboxBadgePlan,
                    stuffboxBadgeIssuer: users.stuffboxBadgeIssuer,
                    stuffboxBadgeExpiresAt: users.stuffboxBadgeExpiresAt,
                })
                    .from(users)
                    .where(userConditions)
                    .limit(limit);

                searchUsers = localUsers.map((user) => ({
                    ...user,
                    stuffboxBadge: stuffboxBadgeFromStoredUser(user),
                }));
            }
            searchUsers = searchUsers.map((searchUser) => redactSensitiveUserSummary({
                ...searchUser,
                isRemote: false,
                nodeIsNsfw: localNodeIsNsfw,
            }, canViewSensitive));
        }

        // Search matching usernames through the replicated swarm handle directory.
        // This is independent of post/node volume and never broadcasts a query to the whole swarm.
        if ((type === 'all' || type === 'users') && !parseRemoteHandleQuery(query)) {
            const directoryQuery = localSearchQuery.toLowerCase();
            if (directoryQuery.length >= 2 && /^[a-z0-9_ -]{2,30}$/i.test(directoryQuery)) {
                const remoteUsers = (await searchKnownSwarmUsers(directoryQuery, {
                    limit,
                    localDomain,
                    excludedDomains: mutedDomains,
                    timeoutMs: SEARCH_SWARM_TIMEOUT_MS,
                }))
                    .map(toSearchUser)
                    .map((user) => redactSensitiveUserSummary(user, canViewSensitive));
                searchUsers = mergeSearchUsers(searchUsers, remoteUsers, limit);
            }
        }

        // Swarm user lookup (exact handle@domain queries)
        if ((type === 'all' || type === 'users') && searchUsers.length < limit) {
            const parsedRemote = parseRemoteHandleQuery(query);
            if (parsedRemote) {
                // Only lookup on swarm nodes
                let isSwarm = await isSwarmNode(parsedRemote.domain);
                if (!isSwarm) {
                    // User-supplied search targets are transient probes, not
                    // authority to add a node to every feed and gossip pool.
                    isSwarm = Boolean(await probeTransientNode(parsedRemote.domain));
                }

                if (isSwarm) {
                    try {
                        const profileData = await fetchSwarmUserProfile(parsedRemote.handle, parsedRemote.domain, 0);
                        if (profileData?.profile) {
                            const profile = profileData.profile;
                            const canAccessProfile = await canCurrentViewerAccessSensitiveRemoteProfile({
                                accountIsNsfw: profile.isNsfw,
                                nodeIsNsfw: profile.nodeIsNsfw,
                            });
                            const fullHandle = `${parsedRemote.handle}@${parsedRemote.domain}`;
                            const remoteUser: SearchUser = {
                                id: `swarm:${parsedRemote.domain}:${parsedRemote.handle}`,
                                handle: fullHandle,
                                // The display name is public identity metadata, even when the
                                // rest of an adult profile is restricted. Keep its authored
                                // casing while continuing to hide sensitive presentation fields.
                                displayName: profile.displayName || parsedRemote.handle,
                                avatarUrl: canAccessProfile ? profile.avatarUrl || null : null,
                                bio: canAccessProfile ? profile.bio || null : null,
                                profileUrl: `https://${parsedRemote.domain}/@${parsedRemote.handle}`,
                                isRemote: true,
                                isNsfw: profile.isNsfw,
                                nodeIsNsfw: profile.nodeIsNsfw,
                                stuffboxBadge: profile.stuffboxBadge as StuffboxBadge | null | undefined,
                            };
                            if (!searchUsers.some((user) => user.handle.toLowerCase() === remoteUser.handle.toLowerCase())) {
                                searchUsers = [remoteUser, ...searchUsers].slice(0, limit);
                            }
                        }
                    } catch (error) {
                        console.error(`[Search] Error fetching swarm user ${parsedRemote.handle}@${parsedRemote.domain}:`, error);
                    }
                }
            }
        }

        const followedLocalIds = new Set<string>();
        const followedRemoteHandles = new Set<string>();
        if (viewer && searchUsers.length > 0) {
            const blockedNodeDomains = Array.from(await getBlockedNodeDomains());
            const localUserIds = searchUsers
                .filter((searchUser) => searchUser.isRemote !== true)
                .map((searchUser) => searchUser.id);
            const remoteHandles = searchUsers
                .filter((searchUser) => searchUser.isRemote === true)
                .map((searchUser) => searchUser.handle.toLowerCase());

            if (localUserIds.length > 0) {
                const localFollowRows = await db
                    .select({ followingId: follows.followingId })
                    .from(follows)
                    .where(and(
                        eq(follows.followerId, viewer.id),
                        inArray(follows.followingId, localUserIds),
                    ));
                localFollowRows.forEach((follow) => followedLocalIds.add(follow.followingId));
            }

            if (remoteHandles.length > 0) {
                const remoteFollowRows = await db
                    .select({ targetHandle: remoteFollows.targetHandle })
                    .from(remoteFollows)
                    .where(and(
                        eq(remoteFollows.followerId, viewer.id),
                        inArray(remoteFollows.targetHandle, remoteHandles),
                        isNull(remoteFollows.suspendedAt),
                        ...(blockedNodeDomains.length > 0
                            ? [notInArray(remoteFollows.targetNodeDomain, blockedNodeDomains)]
                            : []),
                    ));
                remoteFollowRows.forEach((follow) => {
                    followedRemoteHandles.add(follow.targetHandle.toLowerCase());
                });
            }
        }
        searchUsers = searchUsers.map((searchUser) => ({
            ...searchUser,
            isFollowing: searchUser.isRemote === true
                ? followedRemoteHandles.has(searchUser.handle.toLowerCase())
                : followedLocalIds.has(searchUser.id),
        }));

        const moderatedUsers = await db.select({ id: users.id })
            .from(users)
            .where(or(eq(users.isSuspended, true), eq(users.isSilenced, true)));
        const moderatedIds = moderatedUsers.map((item) => item.id);
        let remoteSearchPosts: Array<Record<string, unknown>> = [];

        // Search posts
        if (type === 'posts' || (type === 'all' && !isHandleSearch)) {
            const indexedPostIds = await searchIndexedPostIds('local', localSearchQuery);
            const postResults = indexedPostIds.length
                ? await db.query.posts.findMany({
                    where: {
                        id: { in: indexedPostIds },
                        isRemoved: false,
                        ...(moderatedIds.length ? { userId: { notIn: moderatedIds } } : {}),
                    },
                    with: searchPostRelations,
                    orderBy: (posts, { desc }) => [desc(posts.createdAt)],
                    limit,
                })
                : [];
            searchPosts = postResults;
            if (!canViewSensitive) {
                searchPosts = searchPosts.filter((post) => !isPostSensitive({
                    postIsNsfw: post.isNsfw,
                    authorIsNsfw: (post as typeof post & {
                        author?: { isNsfw?: boolean };
                    }).author?.isNsfw,
                    nodeIsNsfw: localNodeIsNsfw,
                    isRemote: false,
                }));
            }

            // Populate isLiked and isReposted for authenticated users using the
            // viewer already resolved for content visibility.
            if (viewer && searchPosts.length > 0) {
                const postIds = searchPosts.map(p => p.id).filter(Boolean);

                if (postIds.length > 0) {
                    const viewerLikes = await db.query.likes.findMany({
                        where: { AND: [{ userId: viewer.id }, { postId: { in: postIds } }] },
                    });
                    const likedPostIds = new Set(viewerLikes.map(l => l.postId));

                    const viewerReposts = await db.query.posts.findMany({
                        where: { AND: [{ userId: viewer.id }, { repostOfId: { in: postIds } }, { isRemoved: false }] },
                    });
                    const repostedPostIds = new Set(viewerReposts.map(r => r.repostOfId));

                    searchPosts = searchPosts.map(p => ({
                        ...p,
                        isLiked: likedPostIds.has(p.id),
                        isReposted: repostedPostIds.has(p.id),
                    }));
                }
            }

            // Search the continuously refreshed, validated cache. Search latency and
            // availability therefore do not grow with the peer count.
            if (localSearchQuery.length >= 2) {
                const normalizedLocalDomain = localDomain;
                const excludedDomains = new Set(mutedDomains);
                excludedDomains.add(normalizedLocalDomain);
                const swarmResults = await getCachedSwarmTimeline({
                    limit,
                    includeNsfw: canViewSensitive,
                    query: localSearchQuery,
                    excludeDomains: excludedDomains,
                });
                remoteSearchPosts = swarmResults.posts.map((post) => redactSensitivePostForViewer(
                    mapSwarmPostToPost(post, { localDomain: normalizedLocalDomain }) as unknown as Record<string, unknown>,
                    {
                        canViewSensitive,
                        localNodeDomain: normalizedLocalDomain,
                        localNodeIsNsfw,
                    },
                ));
            }
        }

        const localSearchPosts = searchPosts.map((post) => redactSensitivePostForViewer(
            attachStoredStuffboxBadgesToPost(post) as unknown as Record<string, unknown>,
            {
                canViewSensitive,
                localNodeDomain: localDomain || 'localhost:43821',
                localNodeIsNsfw,
            },
        ));
        const seenPostIds = new Set<string>();
        const mergedSearchPosts = [...localSearchPosts, ...remoteSearchPosts]
            .sort((left, right) => {
                const leftTime = new Date(String(left.createdAt || 0)).getTime();
                const rightTime = new Date(String(right.createdAt || 0)).getTime();
                return rightTime - leftTime;
            })
            .filter((post) => {
                const id = String(post.id || '');
                if (!id || seenPostIds.has(id)) return false;
                seenPostIds.add(id);
                return true;
            })
            .slice(0, limit);

        return NextResponse.json({
            users: searchUsers,
            posts: mergedSearchPosts,
        });
    } catch (error) {
        console.error('Search error:', error);
        return NextResponse.json({ error: 'Search failed' }, { status: 500 });
    }
}
