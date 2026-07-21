import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    authenticateUser: vi.fn(),
    createSession: vi.fn(),
    isLocalNodeNsfw: vi.fn(),
    admitLoginRequest: vi.fn(),
    clearLoginFailures: vi.fn(),
    createAuthAbuseContext: vi.fn(),
    recordLoginFailure: vi.fn(),
    tryAcquireAuthWork: vi.fn(),
    getTurnstileConfiguration: vi.fn(),
    verifyTurnstileToken: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
    authenticateUser: mocks.authenticateUser,
    createSession: mocks.createSession,
}));

vi.mock('@/lib/node/local-node', () => ({
    isLocalNodeNsfw: mocks.isLocalNodeNsfw,
}));

vi.mock('@/lib/auth/abuse-protection', () => ({
    admitLoginRequest: mocks.admitLoginRequest,
    clearLoginFailures: mocks.clearLoginFailures,
    createAuthAbuseContext: mocks.createAuthAbuseContext,
    recordLoginFailure: mocks.recordLoginFailure,
    tryAcquireAuthWork: mocks.tryAcquireAuthWork,
}));

vi.mock('@/lib/turnstile', () => ({
    getTurnstileConfiguration: mocks.getTurnstileConfiguration,
    verifyTurnstileToken: mocks.verifyTurnstileToken,
}));

import { POST } from './route';

function loginRequest(turnstileToken?: string) {
    return new Request('https://node.social/api/auth/login', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-forwarded-for': '203.0.113.8',
        },
        body: JSON.stringify({
            email: 'alice@example.com',
            password: 'correct-horse-battery-staple',
            ...(turnstileToken ? { turnstileToken } : {}),
        }),
    });
}

describe('POST /api/auth/login adaptive protection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createAuthAbuseContext.mockReturnValue({
            clientKey: 'client',
            identityKey: 'identity',
            clientAddress: '203.0.113.8',
        });
        mocks.admitLoginRequest.mockResolvedValue({
            allowed: true,
            challengeRequired: false,
            retryAfterSeconds: 0,
        });
        mocks.tryAcquireAuthWork.mockImplementation(() => vi.fn());
        mocks.getTurnstileConfiguration.mockResolvedValue(null);
        mocks.verifyTurnstileToken.mockResolvedValue(true);
        mocks.isLocalNodeNsfw.mockResolvedValue(false);
        mocks.authenticateUser.mockResolvedValue({
            id: 'user-id',
            handle: 'alice@node.social',
            username: 'alice',
            homeDomain: 'node.social',
            isLocalAccount: true,
            displayName: 'Alice',
            did: 'did:synapsis:alice',
            publicKey: 'PUBLIC KEY',
            privateKeyEncrypted: 'ENCRYPTED PRIVATE KEY',
            isNsfw: false,
            nsfwEnabled: false,
            ageVerifiedAt: null,
        });
    });

    it('does not load or verify Turnstile for an ordinary successful login', async () => {
        const response = await POST(loginRequest());

        expect(response.status).toBe(200);
        expect(mocks.getTurnstileConfiguration).not.toHaveBeenCalled();
        expect(mocks.verifyTurnstileToken).not.toHaveBeenCalled();
        expect(mocks.createSession).toHaveBeenCalledWith('user-id');
        expect(mocks.clearLoginFailures).toHaveBeenCalled();
        await expect(response.json()).resolves.toMatchObject({
            user: {
                handle: 'alice@node.social',
                username: 'alice',
                homeDomain: 'node.social',
                isLocalAccount: true,
            },
        });
    });

    it('requires a token when repeated failures trigger a configured challenge', async () => {
        mocks.admitLoginRequest.mockResolvedValue({
            allowed: true,
            challengeRequired: true,
            retryAfterSeconds: 0,
        });
        mocks.getTurnstileConfiguration.mockResolvedValue({
            siteKey: 'site-key',
            secretKey: 'secret-key',
            hostname: 'node.social',
        });

        const response = await POST(loginRequest());

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
            requiresTurnstile: true,
            turnstileAction: 'login',
        });
        expect(mocks.authenticateUser).not.toHaveBeenCalled();
    });

    it('validates the challenge action and client address before password work', async () => {
        const configuration = {
            siteKey: 'site-key',
            secretKey: 'secret-key',
            hostname: 'node.social',
        };
        mocks.admitLoginRequest.mockResolvedValue({
            allowed: true,
            challengeRequired: true,
            retryAfterSeconds: 0,
        });
        mocks.getTurnstileConfiguration.mockResolvedValue(configuration);

        const response = await POST(loginRequest('turnstile-token'));

        expect(response.status).toBe(200);
        expect(mocks.verifyTurnstileToken).toHaveBeenCalledWith('turnstile-token', {
            action: 'login',
            configuration,
            ip: '203.0.113.8',
        });
    });

    it('records invalid credentials without treating server faults as bad passwords', async () => {
        mocks.authenticateUser.mockRejectedValue(new Error('Invalid email or password'));

        const response = await POST(loginRequest());

        expect(response.status).toBe(401);
        expect(mocks.recordLoginFailure).toHaveBeenCalled();
        expect(mocks.clearLoginFailures).not.toHaveBeenCalled();
    });
});
