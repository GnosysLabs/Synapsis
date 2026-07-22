import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    select: vi.fn(),
    searchKnownUsers: vi.fn(),
    viewerAccess: vi.fn(),
    postFindMany: vi.fn(),
    getCachedSwarmTimeline: vi.fn(),
    searchIndexedPostIds: vi.fn(),
    canAccessRemoteProfile: vi.fn(),
    fetchSwarmUserProfile: vi.fn(),
    isSwarmNode: vi.fn(),
}));

function queryBuilder(rows: unknown[]) {
    const builder = {
        from: vi.fn(),
        where: vi.fn(),
        limit: vi.fn().mockResolvedValue(rows),
        then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => (
            Promise.resolve(rows).then(resolve, reject)
        ),
    };
    builder.from.mockReturnValue(builder);
    builder.where.mockReturnValue(builder);
    return builder;
}

vi.mock('drizzle-orm', () => {
    const expression = (operator: string) => (...values: unknown[]) => ({ operator, values });
    return {
        and: expression('and'),
        eq: expression('eq'),
        inArray: expression('inArray'),
        isNull: expression('isNull'),
        like: expression('like'),
        notLike: expression('notLike'),
        or: expression('or'),
    };
});

vi.mock('@/db', () => {
    const columns = new Proxy({}, { get: (_target, property) => String(property) });
    return {
        db: {
            select: mocks.select,
            query: {
                posts: { findMany: mocks.postFindMany },
                likes: { findMany: vi.fn().mockResolvedValue([]) },
            },
        },
        follows: columns,
        mutedNodes: columns,
        posts: columns,
        remoteFollows: columns,
        users: columns,
    };
});

vi.mock('@/lib/nsfw/viewer-access', () => ({
    getSensitiveContentViewerAccess: mocks.viewerAccess,
}));
vi.mock('@/lib/nsfw/content-visibility', () => ({
    isPostSensitive: vi.fn(() => false),
    redactSensitivePostForViewer: vi.fn((post) => post),
    redactSensitiveUserSummary: vi.fn((user) => user),
}));
vi.mock('@/lib/nsfw/remote-profile-access', () => ({
    canCurrentViewerAccessSensitiveRemoteProfile: mocks.canAccessRemoteProfile,
}));
vi.mock('@/lib/swarm/user-directory-search', () => ({
    searchKnownSwarmUsers: mocks.searchKnownUsers,
}));
vi.mock('@/lib/swarm/content-cache', () => ({
    getCachedSwarmTimeline: mocks.getCachedSwarmTimeline,
}));
vi.mock('@/lib/search/post-index', () => ({
    searchIndexedPostIds: mocks.searchIndexedPostIds,
}));
vi.mock('@/lib/swarm/interactions', () => ({
    fetchSwarmUserProfile: mocks.fetchSwarmUserProfile,
    isSwarmNode: mocks.isSwarmNode,
}));
vi.mock('@/lib/swarm/transient-node-probe', () => ({ probeTransientNode: vi.fn() }));
vi.mock('@/lib/swarm/node-blocklist', () => ({ getBlockedNodeDomains: vi.fn().mockResolvedValue(new Set()) }));

import { GET } from './route';

describe('GET /api/search swarm users', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'local.com');
        mocks.viewerAccess.mockResolvedValue({
            viewer: { id: 'viewer-id' },
            localNodeIsNsfw: false,
            canViewSensitive: true,
        });
        mocks.select.mockReturnValue(queryBuilder([]));
        mocks.searchKnownUsers.mockResolvedValue([{
            handle: 'theredpillgod@rprh.link',
            displayName: 'The Red Pill God',
            avatarUrl: 'https://rprh.link/avatar.jpg',
            isRemote: true,
            nodeDomain: 'rprh.link',
            isNsfw: false,
            nodeIsNsfw: true,
        }]);
        mocks.postFindMany.mockResolvedValue([]);
        mocks.searchIndexedPostIds.mockResolvedValue([]);
        mocks.getCachedSwarmTimeline.mockResolvedValue({
            posts: [],
            sources: [],
            fetchedAt: '2026-07-18T00:00:00.000Z',
            continuationDate: null,
        });
        mocks.canAccessRemoteProfile.mockResolvedValue(false);
        mocks.isSwarmNode.mockResolvedValue(true);
        mocks.fetchSwarmUserProfile.mockResolvedValue(null);
    });

    it('finds an exact remote username without requiring its node domain', async () => {
        mocks.select
            .mockReturnValueOnce(queryBuilder([]))
            .mockReturnValueOnce(queryBuilder([]))
            .mockReturnValueOnce(queryBuilder([]))
            .mockReturnValueOnce(queryBuilder([{ targetHandle: 'theredpillgod@rprh.link' }]))
            .mockReturnValueOnce(queryBuilder([]));

        const response = await GET(new Request(
            'https://local.com/api/search?q=%40theredpillgod',
        ));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            users: [{
                handle: 'theredpillgod@rprh.link',
                displayName: 'The Red Pill God',
                nodeDomain: 'rprh.link',
                isRemote: true,
                isFollowing: true,
            }],
            posts: [],
        });
        expect(mocks.searchKnownUsers).toHaveBeenCalledWith(
            'theredpillgod',
            expect.objectContaining({
                limit: 20,
                localDomain: 'local.com',
                timeoutMs: 1_500,
            }),
        );
        expect(mocks.postFindMany).not.toHaveBeenCalled();
        expect(mocks.getCachedSwarmTimeline).not.toHaveBeenCalled();
    });

    it('finds matching post text on remote swarm nodes', async () => {
        mocks.getCachedSwarmTimeline.mockResolvedValue({
            posts: [{
                id: 'post-1',
                content: 'Yolked!',
                createdAt: '2026-07-17T12:00:00.000Z',
                author: {
                    handle: 'bubbabator',
                    displayName: 'BubbaBator',
                    avatarUrl: 'https://rprh.link/avatar.jpg',
                    isNsfw: false,
                },
                nodeDomain: 'rprh.link',
                nodeIsNsfw: false,
                isNsfw: false,
                likeCount: 2,
                repostCount: 1,
                replyCount: 0,
            }],
            sources: [{ domain: 'rprh.link', postCount: 1 }],
            fetchedAt: '2026-07-18T00:00:00.000Z',
            continuationDate: null,
        });

        const response = await GET(new Request(
            'https://local.com/api/search?q=Yolked&type=posts',
        ));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            users: [],
            posts: [{
                id: 'swarm:rprh.link:post-1',
                content: 'Yolked!',
                nodeDomain: 'rprh.link',
                author: { handle: 'bubbabator@rprh.link' },
            }],
        });
        expect(mocks.getCachedSwarmTimeline).toHaveBeenCalledWith(
            expect.objectContaining({
                limit: 20,
                includeNsfw: true,
                query: 'Yolked',
                excludeDomains: expect.any(Set),
            }),
        );
        const options = mocks.getCachedSwarmTimeline.mock.calls[0]?.[0] as {
            excludeDomains: Set<string>;
        };
        expect(options.excludeDomains).toContain('local.com');
    });

    it('preserves a restricted remote profile display name while hiding sensitive fields', async () => {
        mocks.fetchSwarmUserProfile.mockResolvedValue({
            profile: {
                handle: 'bubbabator@batorbros.bond',
                displayName: 'BubbaBator',
                avatarUrl: 'https://batorbros.bond/avatar.jpg',
                bio: 'restricted bio',
                isNsfw: true,
                nodeIsNsfw: true,
                profilePresentationVerified: true,
            },
            posts: [],
            nodeDomain: 'batorbros.bond',
        });

        const response = await GET(new Request(
            'https://local.com/api/search?q=bubbabator%40batorbros.bond&type=users',
        ));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            users: [{
                handle: 'bubbabator@batorbros.bond',
                displayName: 'BubbaBator',
                avatarUrl: null,
                bio: null,
            }],
            posts: [],
        });
        expect(mocks.canAccessRemoteProfile).toHaveBeenCalledWith({
            accountIsNsfw: true,
            nodeIsNsfw: true,
        });
    });
});
