import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    user: null as null | { nsfwEnabled: boolean; ageVerifiedAt?: string | null },
    config: {
        domain: 'local.example',
        isNsfw: false,
        classificationKnown: true,
    },
}));

vi.mock('@/lib/contexts/AuthContext', () => ({
    useAuth: () => ({ user: mocks.user }),
}));

vi.mock('@/lib/contexts/ConfigContext', () => ({
    useRuntimeConfig: () => ({ config: mocks.config }),
    useDomain: () => mocks.config.domain,
}));

import { AvatarImage, getDiceBearAvatarSeed, getDiceBearAvatarUrl } from './AvatarImage';

beforeEach(() => {
    mocks.user = null;
    mocks.config.domain = 'local.example';
    mocks.config.isNsfw = false;
    mocks.config.classificationKnown = true;
});

describe('getDiceBearAvatarUrl', () => {
    it('keeps the DiceBear seed stable while routing the artwork through this node', () => {
        const first = getDiceBearAvatarUrl('cyph3r@node.example');
        expect(first).toBe(getDiceBearAvatarUrl('cyph3r@node.example'));
        expect(first).toBe('/avatar?seed=cyph3r%40node.example');
        expect(first).not.toContain('api.dicebear.com');
    });

    it('uses the same seed for bare and qualified forms of a remote account', () => {
        expect(getDiceBearAvatarSeed('cyph3r', 'node.example')).toBe('cyph3r@node.example');
        expect(getDiceBearAvatarUrl('cyph3r', 'node.example')).toBe(
            getDiceBearAvatarUrl('cyph3r@node.example'),
        );
    });

    it('qualifies a local account with the runtime node domain', () => {
        expect(getDiceBearAvatarSeed('cyph3r', undefined, 'node.example')).toBe('cyph3r@node.example');
        expect(getDiceBearAvatarUrl('cyph3r', undefined, 'node.example')).toBe(
            getDiceBearAvatarUrl('cyph3r@node.example'),
        );
    });

    it('keeps an explicit remote domain ahead of the local node fallback', () => {
        expect(getDiceBearAvatarSeed('cyph3r', 'remote.example', 'local.example')).toBe(
            'cyph3r@remote.example',
        );
    });

    it('never emits a restricted custom avatar URL into signed-out markup', () => {
        const privateUrl = 'https://adult.example/private-avatar.jpg';
        const html = renderToStaticMarkup(createElement(AvatarImage, {
            avatarUrl: privateUrl,
            seed: 'adult@adult.example',
            nodeDomain: 'adult.example',
            isNsfw: true,
            nodeIsNsfw: true,
        }));

        expect(html).not.toContain(privateUrl);
        expect(html).toContain('/avatar?seed=');
    });

    it('fails closed when a remote avatar has incomplete classification metadata', () => {
        const privateUrl = 'https://remote.example/unclassified-avatar.jpg';
        const html = renderToStaticMarkup(createElement(AvatarImage, {
            avatarUrl: privateUrl,
            seed: 'unknown@remote.example',
            nodeDomain: 'remote.example',
            isNsfw: false,
        }));

        expect(html).not.toContain(privateUrl);
        expect(html).toContain('/avatar?seed=');
    });

    it('fails closed while the local node classification is unknown', () => {
        mocks.config.classificationKnown = false;
        const privateUrl = 'https://local.example/unclassified-local-avatar.jpg';
        const html = renderToStaticMarkup(createElement(AvatarImage, {
            avatarUrl: privateUrl,
            seed: 'local-user',
            nodeDomain: 'local.example',
            isNsfw: false,
            nodeIsNsfw: false,
        }));

        expect(html).not.toContain(privateUrl);
        expect(html).toContain('/avatar?seed=');
    });

    it('uses the custom avatar only after sensitive viewing is enabled', () => {
        mocks.user = { nsfwEnabled: true, ageVerifiedAt: '2026-07-17T00:00:00.000Z' };
        const privateUrl = 'https://cdn.stuffbox.xyz/allowed-avatar.jpg';
        const html = renderToStaticMarkup(createElement(AvatarImage, {
            avatarUrl: privateUrl,
            seed: 'adult@adult.example',
            nodeDomain: 'adult.example',
            isNsfw: true,
            nodeIsNsfw: true,
        }));

        expect(html).toContain(privateUrl);
    });

    it('still rejects an eligible remote avatar hosted by the peer in production', () => {
        mocks.user = { nsfwEnabled: true, ageVerifiedAt: '2026-07-17T00:00:00.000Z' };
        const trackingUrl = 'https://remote.example/viewer-specific-avatar.gif';
        vi.stubEnv('NODE_ENV', 'production');
        try {
            const html = renderToStaticMarkup(createElement(AvatarImage, {
                avatarUrl: trackingUrl,
                seed: 'remote@remote.example',
                nodeDomain: 'remote.example',
                isNsfw: false,
                nodeIsNsfw: false,
            }));

            expect(html).not.toContain(trackingUrl);
            expect(html).toContain('/avatar?seed=');
        } finally {
            vi.unstubAllEnvs();
        }
    });
});
