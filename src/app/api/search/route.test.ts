import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    select: vi.fn(),
    searchKnownUsers: vi.fn(),
    viewerAccess: vi.fn(),
    postFindMany: vi.fn(),
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
vi.mock('@/lib/swarm/interactions', () => ({
    fetchSwarmUserProfile: vi.fn(),
    isSwarmNode: vi.fn(),
}));
vi.mock('@/lib/swarm/discovery', () => ({ discoverNode: vi.fn() }));

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
    });
});
