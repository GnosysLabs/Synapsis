import { NextResponse } from 'next/server';
import { db, mutedNodes, users, posts } from '@/db';
import { like, or, and, eq, isNull, notLike } from 'drizzle-orm';
import { fetchSwarmUserProfile, isSwarmNode } from '@/lib/swarm/interactions';
import { discoverNode } from '@/lib/swarm/discovery';
import { normalizeNodeDomain } from '@/lib/swarm/node-domain';
import type { SwarmDirectoryUser } from '@/lib/swarm/user-directory';
import { searchKnownSwarmUsers } from '@/lib/swarm/user-directory-search';
import { fetchSwarmTimeline } from '@/lib/swarm/timeline';
import { mapSwarmPostToPost } from '@/lib/swarm/feed-post';
import { canCurrentViewerAccessSensitiveRemoteProfile } from '@/lib/nsfw/remote-profile-access';
import { getSensitiveContentViewerAccess } from '@/lib/nsfw/viewer-access';
import {
    isPostSensitive,
    redactSensitivePostForViewer,
    redactSensitiveUserSummary,
} from '@/lib/nsfw/content-visibility';

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
    return {
        id: `swarm:${user.nodeDomain}:${user.handle.split('@')[0]}`,
        handle: user.handle,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        bio: null,
        profileUrl: `https://${user.nodeDomain}/@${user.handle.split('@')[0]}`,
        isRemote: true,
        isNsfw: user.isNsfw,
        nodeIsNsfw: user.nodeIsNsfw,
        nodeDomain: user.nodeDomain,
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
        const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 50);

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
        const mutedDomains = new Set(
            mutedNodeRows.map((row) => normalizeNodeDomain(row.nodeDomain)),
        );

        // Normalize query for local user search
        // Strip leading @ and local domain if present
        let localSearchQuery = query.trim();
        if (localSearchQuery.startsWith('@')) {
            localSearchQuery = localSearchQuery.slice(1);
        }
        // Remove local domain if searching like "admin2@dev.syn.quest"
        const localDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || process.env.NODE_DOMAIN;
        if (localDomain && localSearchQuery.includes('@')) {
            const parts = localSearchQuery.split('@');
            if (parts[1] === localDomain) {
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
                })
                    .from(users)
                    .where(and(
                        eq(users.handle, localSearchQuery),
                        isNull(users.nodeId),
                        notLike(users.handle, '%@%'),
                        eq(users.isSuspended, false),
                        eq(users.isSilenced, false)
                    ))
                    .limit(1);

                if (exactMatch.length > 0) {
                    searchUsers = exactMatch;
                }
            }

            if (searchUsers.length === 0) {
                const userConditions = and(
                    or(
                        like(users.handle, searchPattern),
                        like(users.displayName, searchPattern),
                        like(users.bio, searchPattern)
                    ),
                    isNull(users.nodeId),
                    notLike(users.handle, '%@%'),
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
                })
                    .from(users)
                    .where(userConditions)
                    .limit(limit);

                // Filter out remote placeholder users (those with @ in handle)
                searchUsers = localUsers.filter(u => !u.handle.includes('@'));
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
                    const discovery = await discoverNode(parsedRemote.domain);
                    isSwarm = discovery.success;
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
                                displayName: canAccessProfile ? profile.displayName || parsedRemote.handle : parsedRemote.handle,
                                avatarUrl: canAccessProfile ? profile.avatarUrl || null : null,
                                bio: canAccessProfile ? profile.bio || null : null,
                                profileUrl: `https://${parsedRemote.domain}/@${parsedRemote.handle}`,
                                isRemote: true,
                                isNsfw: profile.isNsfw,
                                nodeIsNsfw: profile.nodeIsNsfw,
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

        const moderatedUsers = await db.select({ id: users.id })
            .from(users)
            .where(or(eq(users.isSuspended, true), eq(users.isSilenced, true)));
        const moderatedIds = moderatedUsers.map((item) => item.id);
        let remoteSearchPosts: Array<Record<string, unknown>> = [];

        // Search posts
        if (type === 'posts' || (type === 'all' && !isHandleSearch)) {
            const postResults = await db.query.posts.findMany({
                where: {
                    content: { like: searchPattern },
                    isRemoved: false,
                    ...(moderatedIds.length ? { userId: { notIn: moderatedIds } } : {}),
                },
                with: searchPostRelations,
                orderBy: (posts, { desc }) => [desc(posts.createdAt)],
                limit,
            });
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

            // Search every known active peer for matching post text. Each peer searches
            // its own database, so this covers the swarm without downloading timelines
            // or imposing a node-count ceiling.
            if (localSearchQuery.length >= 2) {
                const normalizedLocalDomain = normalizeNodeDomain(localDomain || 'localhost:43821');
                const excludedDomains = new Set(mutedDomains);
                excludedDomains.add(normalizedLocalDomain);
                const swarmResults = await fetchSwarmTimeline(undefined, limit, {
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
            post as unknown as Record<string, unknown>,
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
