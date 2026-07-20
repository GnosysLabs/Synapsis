import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({
    db: {
        query: {
            nodes: {
                findFirst: vi.fn(),
                findMany: vi.fn(),
            },
        },
    },
}));

import { verifyTurnstileToken } from './turnstile';

const configuration = {
    siteKey: 'site-key',
    secretKey: 'secret-key',
    hostname: 'node.social',
};

describe('Turnstile server validation', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('accepts only the expected hostname and action', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            success: true,
            hostname: 'node.social',
            action: 'login',
        }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(verifyTurnstileToken('token', {
            action: 'login',
            configuration,
            ip: '203.0.113.8',
        })).resolves.toBe(true);

        const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
        expect(request.signal).toBeInstanceOf(AbortSignal);
        expect(request.body).toBeInstanceOf(FormData);
    });

    it('rejects a successful token minted for another action', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
            success: true,
            hostname: 'node.social',
            action: 'register',
        }), { status: 200 })));

        await expect(verifyTurnstileToken('token', {
            action: 'login',
            configuration,
        })).resolves.toBe(false);
    });

    it('rejects a successful token minted for another hostname', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
            success: true,
            hostname: 'attacker.example',
            action: 'login',
        }), { status: 200 })));

        await expect(verifyTurnstileToken('token', {
            action: 'login',
            configuration,
        })).resolves.toBe(false);
    });
});
