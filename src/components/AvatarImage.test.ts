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
    it('uses the site-wide bottts-neutral style and a stable encoded handle seed', () => {
        expect(getDiceBearAvatarUrl('cyph3r@node.example')).toBe(
            'https://api.dicebear.com/9.x/bottts-neutral/svg?seed=cyph3r%40node.example',
        );
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
        expect(html).toContain('api.dicebear.com');
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
        expect(html).toContain('api.dicebear.com');
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
        expect(html).toContain('api.dicebear.com');
    });

    it('uses the custom avatar only after sensitive viewing is enabled', () => {
        mocks.user = { nsfwEnabled: true, ageVerifiedAt: '2026-07-17T00:00:00.000Z' };
        const privateUrl = 'https://adult.example/allowed-avatar.jpg';
        const html = renderToStaticMarkup(createElement(AvatarImage, {
            avatarUrl: privateUrl,
            seed: 'adult@adult.example',
            nodeDomain: 'adult.example',
            isNsfw: true,
            nodeIsNsfw: true,
        }));

        expect(html).toContain(privateUrl);
    });
});
