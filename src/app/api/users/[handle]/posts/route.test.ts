import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    findUser: vi.fn(),
    fetchSwarmUserProfile: vi.fn(),
    isSwarmNode: vi.fn(),
    discoverNode: vi.fn(),
    getSession: vi.fn(),
    isLocalNodeNsfw: vi.fn(),
}));

vi.mock('@/db', () => ({
    db: {
        query: {
            users: { findFirst: mocks.findUser },
        },
    },
    users: {},
    userSwarmReposts: {},
}));

vi.mock('@/lib/auth', () => ({
    getSession: mocks.getSession,
}));

vi.mock('@/lib/node/local-node', () => ({
    isLocalNodeNsfw: mocks.isLocalNodeNsfw,
    requireLocalNodeNsfwClassification: mocks.isLocalNodeNsfw,
}));

vi.mock('@/lib/swarm/interactions', () => ({
    fetchSwarmUserProfile: mocks.fetchSwarmUserProfile,
    isSwarmNode: mocks.isSwarmNode,
}));

vi.mock('@/lib/swarm/discovery', () => ({
    discoverNode: mocks.discoverNode,
}));

import { GET } from './route';

const remoteProfile = {
    handle: 'remoteuser',
    displayName: 'Remote User',
    followersCount: 0,
    followingCount: 0,
    postsCount: 1,
    createdAt: '2026-07-17T00:00:00.000Z',
    isNsfw: false,
    nodeIsNsfw: true,
    nodeDomain: 'adult.example',
};

const remotePost = {
    id: 'post-1',
    content: 'Sensitive post body',
    createdAt: '2026-07-17T00:00:00.000Z',
    isNsfw: false,
    likesCount: 0,
    repostsCount: 0,
    repliesCount: 0,
    nodeDomain: 'adult.example',
    author: {
        handle: 'remoteuser',
        displayName: 'Remote User',
        isNsfw: false,
        nodeIsNsfw: true,
        nodeDomain: 'adult.example',
    },
};

describe('remote profile posts NSFW access', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.findUser.mockResolvedValue(null);
        mocks.isSwarmNode.mockResolvedValue(true);
        mocks.discoverNode.mockResolvedValue({ success: true });
        mocks.getSession.mockResolvedValue(null);
        mocks.isLocalNodeNsfw.mockResolvedValue(false);
    });

    it('does not proxy posts from an adult-only node to a signed-out visitor', async () => {
        mocks.fetchSwarmUserProfile.mockResolvedValue({
            profile: remoteProfile,
            posts: [remotePost],
            nodeDomain: 'adult.example',
            timestamp: '2026-07-17T00:00:00.000Z',
        });

        const response = await GET(
            new Request('https://local.example/api/users/remoteuser%40adult.example/posts'),
            { params: Promise.resolve({ handle: 'remoteuser@adult.example' }) },
        );

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
            posts: [],
            restricted: true,
        });
    });

    it('continues to proxy general-audience profiles publicly', async () => {
        mocks.fetchSwarmUserProfile.mockResolvedValue({
            profile: { ...remoteProfile, nodeIsNsfw: false },
            posts: [{ ...remotePost, author: { ...remotePost.author, nodeIsNsfw: false } }],
            nodeDomain: 'adult.example',
            timestamp: '2026-07-17T00:00:00.000Z',
        });

        const response = await GET(
            new Request('https://local.example/api/users/remoteuser%40adult.example/posts'),
            { params: Promise.resolve({ handle: 'remoteuser@adult.example' }) },
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            posts: [{ content: 'Sensitive post body' }],
        });
    });
});
