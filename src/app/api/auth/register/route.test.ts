import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    registerUser: vi.fn(),
    createSession: vi.fn(),
    verifyTurnstileToken: vi.fn(),
    getTurnstileConfiguration: vi.fn(),
    admitRegistrationRequest: vi.fn(),
    createAuthAbuseContext: vi.fn(),
    tryAcquireAuthWork: vi.fn(),
    requireClassification: vi.fn(),
    update: vi.fn(),
    set: vi.fn(),
    where: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
    registerUser: mocks.registerUser,
    createSession: mocks.createSession,
}));

vi.mock('@/lib/turnstile', () => ({
    verifyTurnstileToken: mocks.verifyTurnstileToken,
    getTurnstileConfiguration: mocks.getTurnstileConfiguration,
}));

vi.mock('@/lib/auth/abuse-protection', () => ({
    admitRegistrationRequest: mocks.admitRegistrationRequest,
    createAuthAbuseContext: mocks.createAuthAbuseContext,
    tryAcquireAuthWork: mocks.tryAcquireAuthWork,
}));

vi.mock('@/lib/node/local-node', () => ({
    requireLocalNodeNsfwClassification: mocks.requireClassification,
}));

vi.mock('@/db', () => ({
    db: { update: mocks.update },
    users: { id: 'users.id' },
}));

vi.mock('drizzle-orm', () => ({
    eq: vi.fn(() => ({})),
}));

import { POST } from './route';

function registrationRequest(confirmAge?: boolean) {
    return new Request('https://node.social/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            handle: 'alice',
            email: 'alice@example.com',
            password: 'correct-horse-battery-staple',
            ...(confirmAge === undefined ? {} : { confirmAge }),
        }),
    });
}

describe('adult-node registration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.requireClassification.mockResolvedValue(true);
        mocks.createAuthAbuseContext.mockReturnValue({
            clientKey: 'client',
            identityKey: 'identity',
            clientAddress: '203.0.113.8',
        });
        mocks.admitRegistrationRequest.mockResolvedValue({
            allowed: true,
            challengeRequired: false,
            retryAfterSeconds: 0,
        });
        mocks.tryAcquireAuthWork.mockImplementation(() => vi.fn());
        mocks.getTurnstileConfiguration.mockResolvedValue(null);
        mocks.verifyTurnstileToken.mockResolvedValue(true);
        mocks.where.mockResolvedValue([]);
        mocks.set.mockReturnValue({ where: mocks.where });
        mocks.update.mockReturnValue({ set: mocks.set });
        mocks.registerUser.mockResolvedValue({
            id: 'user-id',
            handle: 'alice',
            displayName: 'Alice',
            did: 'did:synapsis:alice',
            publicKey: 'PUBLIC KEY',
            privateKeyEncrypted: 'ENCRYPTED PRIVATE KEY',
            isNsfw: false,
            nsfwEnabled: false,
            ageVerifiedAt: null,
        });
    });

    it('cannot be bypassed by omitting the client age checkbox', async () => {
        const response = await POST(registrationRequest());

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            requiresAgeConfirmation: true,
        });
        expect(mocks.registerUser).not.toHaveBeenCalled();
        expect(mocks.createSession).not.toHaveBeenCalled();
    });

    it('persists age verification and adult defaults after explicit confirmation', async () => {
        const response = await POST(registrationRequest(true));

        expect(response.status).toBe(200);
        expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({
            nsfwEnabled: true,
            isNsfw: true,
            ageVerifiedAt: expect.any(Date),
        }));
        expect(mocks.createSession).toHaveBeenCalledWith('user-id');
        await expect(response.json()).resolves.toMatchObject({
            user: {
                isNsfw: true,
                nsfwEnabled: true,
                ageVerifiedAt: expect.any(String),
            },
        });
    });

    it('requires a server-validated challenge only after abuse signals', async () => {
        mocks.admitRegistrationRequest.mockResolvedValue({
            allowed: true,
            challengeRequired: true,
            retryAfterSeconds: 0,
        });
        mocks.getTurnstileConfiguration.mockResolvedValue({
            siteKey: 'site-key',
            secretKey: 'secret-key',
            hostname: 'node.social',
        });

        const response = await POST(registrationRequest(true));

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
            requiresTurnstile: true,
            turnstileAction: 'register',
        });
        expect(mocks.registerUser).not.toHaveBeenCalled();
    });

    it('returns a durable quota response before expensive registration work', async () => {
        mocks.admitRegistrationRequest.mockResolvedValue({
            allowed: false,
            challengeRequired: true,
            retryAfterSeconds: 90,
        });

        const response = await POST(registrationRequest(true));

        expect(response.status).toBe(429);
        expect(response.headers.get('retry-after')).toBe('90');
        expect(mocks.registerUser).not.toHaveBeenCalled();
    });
});
