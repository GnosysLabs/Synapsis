import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    switchSession: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
    switchSession: mocks.switchSession,
}));

import { POST } from './route';

const userId = '11111111-1111-4111-8111-111111111111';

describe('POST /api/auth/switch canonical account contract', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.switchSession.mockResolvedValue({
            user: {
                id: userId,
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
            },
        });
    });

    it('returns the switched account with its canonical identity metadata', async () => {
        const response = await POST(new Request('https://node.social/api/auth/switch', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ userId }),
        }));

        expect(response.status).toBe(200);
        expect(mocks.switchSession).toHaveBeenCalledWith(userId);
        await expect(response.json()).resolves.toMatchObject({
            success: true,
            user: {
                handle: 'alice@node.social',
                username: 'alice',
                homeDomain: 'node.social',
                isLocalAccount: true,
            },
        });
    });
});
