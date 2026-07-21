import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    deliverSwarmUnrepost: vi.fn(),
    findStoredRepost: vi.fn(),
    requireSignedAction: vi.fn(),
    transaction: vi.fn(),
    delete: vi.fn(),
    deleteWhere: vi.fn(),
    update: vi.fn(),
    updateSet: vi.fn(),
    updateWhere: vi.fn(),
    isNodeBlocked: vi.fn(),
}));

const tables = vi.hoisted(() => ({
    users: { id: 'users.id', postsCount: 'users.postsCount' },
    userSwarmReposts: { id: 'userSwarmReposts.id' },
}));

vi.mock('@/db', () => ({
    db: {
        transaction: mocks.transaction,
        query: {
            posts: { findFirst: vi.fn() },
            userSwarmReposts: { findFirst: vi.fn() },
        },
    },
    posts: {},
    notifications: {},
    remoteReposts: {},
    ...tables,
}));

vi.mock('drizzle-orm', () => ({
    eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
    and: vi.fn((...conditions: unknown[]) => ({ conditions })),
    sql: vi.fn((parts: TemplateStringsArray, ...values: unknown[]) => ({ parts, values })),
}));

vi.mock('@/lib/auth', () => ({
    requireAuth: vi.fn(),
}));

vi.mock('@/lib/auth/verify-signature', () => ({
    requireSignedAction: mocks.requireSignedAction,
}));

vi.mock('@/lib/swarm/interactions', () => ({
    deliverSwarmUnrepost: mocks.deliverSwarmUnrepost,
}));

vi.mock('@/lib/swarm/remote-post-snapshot', () => ({
    fetchRemotePostSnapshot: vi.fn(),
}));

vi.mock('@/lib/swarm/node-blocklist', () => ({
    isNodeBlocked: mocks.isNodeBlocked,
}));

import { DELETE } from './route';
import { NODE_BLOCKED_CODE } from '@/lib/swarm/remote-access-protocol';

const originalPostId = '11111111-1111-4111-8111-111111111111';
const postId = `swarm:rprh.link:${originalPostId}`;
const routeContext = { params: Promise.resolve({ id: postId }) };

function signedUnrepostRequest() {
    return new Request(`https://synapsis.social/api/posts/${postId}/repost`, {
        method: 'DELETE',
        body: JSON.stringify({
            action: 'unrepost',
            did: 'did:key:viewer',
            handle: 'viewer',
            ts: Date.now(),
            nonce: crypto.randomUUID(),
            sig: 'signature',
            data: { postId },
        }),
    });
}

describe('remote unrepost cleanup', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'synapsis.social');
        mocks.requireSignedAction.mockResolvedValue({
            id: 'viewer-1',
            handle: 'viewer',
            displayName: 'Viewer',
            avatarUrl: null,
            isSuspended: false,
            isSilenced: false,
        });
        mocks.findStoredRepost.mockResolvedValue({ id: 'stored-repost-1' });
        mocks.isNodeBlocked.mockResolvedValue(false);
        mocks.delete.mockReturnValue({ where: mocks.deleteWhere });
        mocks.updateSet.mockReturnValue({ where: mocks.updateWhere });
        mocks.update.mockReturnValue({ set: mocks.updateSet });
        mocks.transaction.mockImplementation(async (callback) => callback({
            query: { userSwarmReposts: { findFirst: mocks.findStoredRepost } },
            delete: mocks.delete,
            update: mocks.update,
        }));
    });

    it('removes the local repost when the origin has blocked this node', async () => {
        mocks.deliverSwarmUnrepost.mockResolvedValue({
            success: false,
            code: NODE_BLOCKED_CODE,
            error: 'Blocked',
        });

        const response = await DELETE(signedUnrepostRequest(), routeContext);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ success: true, reposted: false });
        expect(mocks.delete).toHaveBeenCalledWith(tables.userSwarmReposts);
        expect(mocks.update).toHaveBeenCalledWith(tables.users);
    });

    it('preserves the local repost for an ordinary delivery failure', async () => {
        mocks.deliverSwarmUnrepost.mockResolvedValue({
            success: false,
            error: 'Temporary network failure',
        });

        const response = await DELETE(signedUnrepostRequest(), routeContext);

        expect(response.status).toBe(502);
        expect(mocks.transaction).not.toHaveBeenCalled();
        expect(mocks.delete).not.toHaveBeenCalled();
    });

    it('removes the local repost without delivery when this node blocked the origin', async () => {
        mocks.isNodeBlocked.mockResolvedValue(true);

        const response = await DELETE(signedUnrepostRequest(), routeContext);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            success: true,
            reposted: false,
            localOnly: true,
        });
        expect(mocks.deliverSwarmUnrepost).not.toHaveBeenCalled();
        expect(mocks.delete).toHaveBeenCalledWith(tables.userSwarmReposts);
    });
});
