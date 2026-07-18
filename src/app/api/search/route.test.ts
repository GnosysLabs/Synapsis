import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    select: vi.fn(),
    searchKnownUsers: vi.fn(),
    viewerAccess: vi.fn(),
    postFindMany: vi.fn(),
    fetchSwarmTimeline: vi.fn(),
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
        mutedNodes: columns,
        posts: columns,
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
    canCurrentViewerAccessSensitiveRemoteProfile: vi.fn(),
}));
vi.mock('@/lib/swarm/user-directory-search', () => ({
    searchKnownSwarmUsers: mocks.searchKnownUsers,
}));
vi.mock('@/lib/swarm/timeline', () => ({
    fetchSwarmTimeline: mocks.fetchSwarmTimeline,
}));
vi.mock('@/lib/swarm/interactions', () => ({
    fetchSwarmUserProfile: vi.fn(),
    isSwarmNode: vi.fn(),
}));
vi.mock('@/lib/swarm/transient-node-probe', () => ({ probeTransientNode: vi.fn() }));

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
        mocks.fetchSwarmTimeline.mockResolvedValue({
            posts: [],
            sources: [],
            fetchedAt: '2026-07-18T00:00:00.000Z',
            continuationDate: null,
        });
    });

    it('finds an exact remote username without requiring its node domain', async () => {
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
        expect(mocks.fetchSwarmTimeline).not.toHaveBeenCalled();
    });

    it('finds matching post text on remote swarm nodes', async () => {
        mocks.fetchSwarmTimeline.mockResolvedValue({
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
        expect(mocks.fetchSwarmTimeline).toHaveBeenCalledWith(
            undefined,
            20,
            expect.objectContaining({
                includeNsfw: true,
                query: 'Yolked',
                excludeDomains: expect.any(Set),
            }),
        );
        const options = mocks.fetchSwarmTimeline.mock.calls[0]?.[2] as {
            excludeDomains: Set<string>;
        };
        expect(options.excludeDomains).toContain('local.com');
    });
});
