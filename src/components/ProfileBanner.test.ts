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

import { ProfileBanner } from './ProfileBanner';

beforeEach(() => {
    mocks.user = null;
    mocks.config.domain = 'local.example';
    mocks.config.isNsfw = false;
    mocks.config.classificationKnown = true;
});

describe('ProfileBanner', () => {
    it('never emits a restricted custom banner URL into signed-out markup', () => {
        const privateUrl = 'https://adult.example/private-banner.jpg';
        const html = renderToStaticMarkup(createElement(ProfileBanner, {
            url: privateUrl,
            accountHandle: 'adult@adult.example',
            nodeDomain: 'adult.example',
            isRemote: true,
            isNsfw: true,
            nodeIsNsfw: true,
        }));

        expect(html).not.toContain(privateUrl);
        expect(html).toContain('Sensitive profile banner hidden');
    });

    it('renders the node-owned banner as a blurred preview for signed-out visitors on an NSFW node', () => {
        mocks.config.isNsfw = true;
        const bannerUrl = 'https://adult.example/node-banner.jpg';
        const html = renderToStaticMarkup(createElement(ProfileBanner, {
            url: bannerUrl,
            nodeIsNsfw: true,
            showBlurredSourceToSignedOutViewers: true,
        }));

        expect(html).toContain(bannerUrl);
        expect(html).toContain('NSFW node banner blurred');
        expect(html).toContain('blur(18px)');
        expect(html).not.toContain('Sensitive profile banner hidden');
    });

    it('does not blur or alter the node banner for an eligible signed-in viewer', () => {
        mocks.config.isNsfw = true;
        mocks.user = { nsfwEnabled: true, ageVerifiedAt: '2026-07-17T00:00:00.000Z' };
        const bannerUrl = 'https://adult.example/node-banner.jpg';
        const html = renderToStaticMarkup(createElement(ProfileBanner, {
            url: bannerUrl,
            nodeIsNsfw: true,
            showBlurredSourceToSignedOutViewers: true,
        }));

        expect(html).toContain(bannerUrl);
        expect(html).not.toContain('NSFW node banner blurred');
        expect(html).not.toContain('blur(18px)');
    });

    it('fails closed for an explicitly remote profile with incomplete classification', () => {
        const privateUrl = 'https://remote.example/unclassified-banner.jpg';
        const html = renderToStaticMarkup(createElement(ProfileBanner, {
            url: privateUrl,
            accountHandle: 'remote-user',
            isRemote: true,
            isNsfw: false,
        }));

        expect(html).not.toContain(privateUrl);
        expect(html).toContain('Sensitive profile banner hidden');
    });

    it('infers a remote profile from its qualified identity and fails closed', () => {
        const privateUrl = 'https://remote.example/unclassified-banner.jpg';
        const html = renderToStaticMarkup(createElement(ProfileBanner, {
            url: privateUrl,
            accountHandle: 'remote-user@remote.example',
            nodeDomain: 'remote.example',
            isNsfw: false,
        }));

        expect(html).not.toContain(privateUrl);
    });

    it('fails closed while the local node classification is unknown', () => {
        mocks.config.classificationKnown = false;
        const privateUrl = 'https://local.example/unclassified-local-banner.jpg';
        const html = renderToStaticMarkup(createElement(ProfileBanner, {
            url: privateUrl,
            accountHandle: 'local-user',
            nodeDomain: 'local.example',
            isNsfw: false,
            nodeIsNsfw: false,
        }));

        expect(html).not.toContain(privateUrl);
        expect(html).toContain('Sensitive profile banner hidden');
    });

    it('renders a classified safe remote banner', () => {
        const publicUrl = 'https://cdn.stuffbox.xyz/public-banner.jpg';
        const html = renderToStaticMarkup(createElement(ProfileBanner, {
            url: publicUrl,
            accountHandle: 'safe-user@safe.example',
            nodeDomain: 'safe.example',
            isRemote: true,
            isNsfw: false,
            nodeIsNsfw: false,
        }));

        expect(html).toContain(publicUrl);
        expect(html).not.toContain('Sensitive profile banner hidden');
    });

    it('does not fetch a classified remote banner from the peer in production', () => {
        mocks.user = { nsfwEnabled: true, ageVerifiedAt: '2026-07-17T00:00:00.000Z' };
        const trackingUrl = 'https://remote.example/viewer-specific-banner.gif';
        vi.stubEnv('NODE_ENV', 'production');
        try {
            const html = renderToStaticMarkup(createElement(ProfileBanner, {
                url: trackingUrl,
                accountHandle: 'remote-user@remote.example',
                nodeDomain: 'remote.example',
                isNsfw: false,
                nodeIsNsfw: false,
            }));

            expect(html).not.toContain(trackingUrl);
        } finally {
            vi.unstubAllEnvs();
        }
    });
});
