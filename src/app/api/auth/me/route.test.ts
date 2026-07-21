import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getSession: vi.fn(),
    getSessionAccounts: vi.fn(),
    isLocalNodeNsfw: vi.fn(),
    getOrRefreshStuffboxBadge: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
    getSession: mocks.getSession,
    getSessionAccounts: mocks.getSessionAccounts,
}));

vi.mock('@/db', () => ({
    db: {},
    users: {},
}));

vi.mock('@/lib/auth/verify-signature', () => ({
    requireSignedAction: vi.fn(),
}));

vi.mock('@/lib/node/local-node', () => ({
    isLocalNodeNsfw: mocks.isLocalNodeNsfw,
}));

vi.mock('@/lib/stuffbox/badge-status', () => ({
    getOrRefreshStuffboxBadge: mocks.getOrRefreshStuffboxBadge,
}));

import { GET } from './route';

describe('GET /api/auth/me canonical account contract', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isLocalNodeNsfw.mockResolvedValue(false);
        mocks.getOrRefreshStuffboxBadge.mockResolvedValue(null);
        mocks.getSession.mockResolvedValue({
            user: {
                id: '11111111-1111-4111-8111-111111111111',
                handle: 'alice@node.social',
                username: 'alice',
                homeDomain: 'node.social',
                isLocalAccount: true,
                displayName: 'Alice',
                avatarUrl: null,
                bio: null,
                website: null,
                dmPrivacy: 'everyone',
                did: 'did:key:alice',
                publicKey: 'PUBLIC KEY',
                privateKeyEncrypted: 'ENCRYPTED PRIVATE KEY',
                isNsfw: false,
                nsfwEnabled: false,
                ageVerifiedAt: null,
            },
        });
        mocks.getSessionAccounts.mockResolvedValue([{
            id: '11111111-1111-4111-8111-111111111111',
            handle: 'alice@node.social',
            username: 'alice',
            homeDomain: 'node.social',
            isLocalAccount: true,
            displayName: 'Alice',
            avatarUrl: null,
            did: 'did:key:alice',
            publicKey: 'PUBLIC KEY',
            privateKeyEncrypted: 'ENCRYPTED PRIVATE KEY',
            email: 'alice@example.com',
            isNsfw: false,
            nsfwEnabled: false,
            ageVerifiedAt: null,
            isActive: true,
        }]);
    });

    it('returns canonical identity fields for the active user and every account', async () => {
        const response = await GET();

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            user: {
                handle: 'alice@node.social',
                username: 'alice',
                homeDomain: 'node.social',
                isLocalAccount: true,
            },
            accounts: [{
                handle: 'alice@node.social',
                username: 'alice',
                homeDomain: 'node.social',
                isLocalAccount: true,
            }],
        });
    });
});
