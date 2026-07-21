import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    nodeIsNsfw: false,
    user: null as null | {
        id: string;
        handle: string;
        displayName: string;
        nsfwEnabled: boolean;
        ageVerifiedAt?: string | null;
    },
}));

vi.mock('@/lib/contexts/AuthContext', () => ({
    useAuth: () => ({
        user: mocks.user,
        did: mocks.user ? 'did:key:viewer' : null,
        handle: mocks.user?.handle || null,
        isIdentityUnlocked: Boolean(mocks.user),
    }),
}));

vi.mock('@/lib/contexts/ToastContext', () => ({
    useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('@/lib/contexts/DialogContext', () => ({
    useAppDialog: () => ({
        showConfirm: vi.fn(),
        showPrompt: vi.fn(),
    }),
}));

vi.mock('@/lib/contexts/ConfigContext', () => ({
    useDomain: () => 'local.example',
    useRuntimeConfig: () => ({
        config: {
            domain: 'local.example',
            isNsfw: mocks.nodeIsNsfw,
            classificationKnown: true,
        },
    }),
}));

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

import { PostCard } from './PostCard';
import type { Post } from '@/lib/types';

const sensitivePost: Post = {
    id: 'sensitive-post',
    content: 'PRIVATE SENSITIVE BODY',
    createdAt: '2026-07-17T00:00:00.000Z',
    likesCount: 0,
    repostsCount: 0,
    repliesCount: 0,
    isNsfw: true,
    nodeIsNsfw: false,
    author: {
        id: 'author-1',
        handle: 'author',
        displayName: 'Author',
        avatarUrl: 'https://local.example/private-avatar.jpg',
        isNsfw: true,
        nodeIsNsfw: false,
    },
    media: [{
        id: 'media-1',
        url: 'https://stuffbox.xyz/private-video.mp4',
        mimeType: 'video/mp4',
    }],
    linkPreviewUrl: 'https://private.example/story',
    linkPreviewTitle: 'PRIVATE PREVIEW TITLE',
    linkPreviewImage: 'https://private.example/preview.jpg',
};

describe('PostCard', () => {
    beforeEach(() => {
        mocks.nodeIsNsfw = false;
        mocks.user = null;
    });

    it('ignores a malformed post without an author instead of crashing the feed', () => {
        const malformedPost = { id: 'orphan-post', author: null } as unknown as Post;

        expect(PostCard({ post: malformedPost })).toBeNull();
    });

    it('keeps undo repost available when the origin disconnected federation access', () => {
        mocks.user = {
            id: 'viewer-1',
            handle: 'viewer',
            displayName: 'Viewer',
            nsfwEnabled: false,
        };
        const unavailablePost: Post = {
            id: 'swarm:blocked.example:11111111-1111-4111-8111-111111111111',
            content: 'This post is unavailable because its origin disconnected federation access.',
            createdAt: '2026-07-17T00:00:00.000Z',
            likesCount: 0,
            repostsCount: 1,
            repliesCount: 0,
            isReposted: true,
            originUnavailable: true,
            nodeDomain: 'blocked.example',
            isSwarm: true,
            isNsfw: false,
            nodeIsNsfw: false,
            author: {
                id: 'remote-author',
                handle: 'author@blocked.example',
                displayName: 'Remote author',
                nodeDomain: 'blocked.example',
                isRemote: true,
                isNsfw: false,
                nodeIsNsfw: false,
            },
        };

        const html = renderToStaticMarkup(createElement(PostCard, { post: unavailablePost }));

        expect(html).toMatch(/<button class="post-action reposted" title="Undo repost">/);
        expect(html).not.toMatch(/<button class="post-action reposted"[^>]*disabled/);
    });

    it('renders an existing remote content-only YouTube URL as a playable embed', () => {
        const html = renderToStaticMarkup(createElement(PostCard, {
            post: {
                id: 'swarm:onlynerds.xyz:a937deec-06d6-4aab-a503-f870bb1a4f2a',
                content: 'Big changes in Diablo 4! https://www.youtube.com/watch?v=Y1t26WsnwCQ',
                createdAt: '2026-07-21T06:44:21.000Z',
                likesCount: 0,
                repostsCount: 0,
                repliesCount: 0,
                isNsfw: false,
                nodeIsNsfw: false,
                nodeDomain: 'onlynerds.xyz',
                isSwarm: true,
                author: {
                    id: 'remote-koolkat',
                    handle: 'koolkat0770@onlynerds.xyz',
                    displayName: 'KoolKat',
                    nodeDomain: 'onlynerds.xyz',
                    isRemote: true,
                    isNsfw: false,
                    nodeIsNsfw: false,
                },
            },
        }));

        expect(html).toContain('<iframe');
        expect(html).toContain('https://www.youtube-nocookie.com/embed/Y1t26WsnwCQ');
        expect(html).not.toContain('>youtube.com</a>');
    });

    it('renders only a warning shell for a signed-out sensitive post', () => {
        const html = renderToStaticMarkup(createElement(PostCard, { post: sensitivePost }));

        expect(html).toContain('Sensitive content');
        expect(html).toContain('Sign in to view');
        expect(html).not.toContain('PRIVATE SENSITIVE BODY');
        expect(html).not.toContain('private-video.mp4');
        expect(html).not.toContain('PRIVATE PREVIEW TITLE');
        expect(html).not.toContain('preview.jpg');
        expect(html).not.toContain('private-avatar.jpg');
    });

    it('keeps Following-feed content hidden after the viewer disables NSFW viewing', () => {
        mocks.user = {
            id: 'viewer-1',
            handle: 'viewer',
            displayName: 'Viewer',
            nsfwEnabled: false,
        };

        const html = renderToStaticMarkup(createElement(PostCard, { post: sensitivePost }));

        expect(html).toContain('Sensitive content');
        expect(html).toContain('Review settings');
        expect(html).not.toContain('PRIVATE SENSITIVE BODY');
        expect(html).not.toContain('private-video.mp4');
    });

    it('fails closed for a remote post whose sensitivity metadata is incomplete', () => {
        const html = renderToStaticMarkup(createElement(PostCard, {
            post: {
                ...sensitivePost,
                id: 'unclassified-remote-post',
                isNsfw: false,
                nodeIsNsfw: undefined,
                nodeDomain: 'remote.example',
                isSwarm: true,
                author: {
                    ...sensitivePost.author,
                    handle: 'author@remote.example',
                    isNsfw: false,
                    nodeIsNsfw: undefined,
                    nodeDomain: 'remote.example',
                    isRemote: true,
                },
            },
        }));

        expect(html).toContain('Sensitive content');
        expect(html).not.toContain('PRIVATE SENSITIVE BODY');
    });

    it('shows sensitive content after an age-verified viewer enables it', () => {
        mocks.user = {
            id: 'viewer-1',
            handle: 'viewer',
            displayName: 'Viewer',
            nsfwEnabled: true,
            ageVerifiedAt: '2026-07-17T00:00:00.000Z',
        };

        const html = renderToStaticMarkup(createElement(PostCard, { post: sensitivePost }));

        expect(html).not.toContain('Sign in to view');
        expect(html).not.toContain('Review settings');
        expect(html).toContain('PRIVATE SENSITIVE BODY');
        expect(html).toContain('private-video.mp4');
    });

    it('does not render peer-hosted media from a remote post in production', () => {
        mocks.user = {
            id: 'viewer-1',
            handle: 'viewer',
            displayName: 'Viewer',
            nsfwEnabled: true,
            ageVerifiedAt: '2026-07-17T00:00:00.000Z',
        };
        vi.stubEnv('NODE_ENV', 'production');
        try {
            const html = renderToStaticMarkup(createElement(PostCard, {
                post: {
                    ...sensitivePost,
                    id: 'remote-tracking-post',
                    content: 'A remote post',
                    isNsfw: false,
                    nodeIsNsfw: false,
                    nodeDomain: 'remote.example',
                    isSwarm: true,
                    author: {
                        ...sensitivePost.author,
                        handle: 'author@remote.example',
                        isNsfw: false,
                        nodeIsNsfw: false,
                        nodeDomain: 'remote.example',
                        isRemote: true,
                    },
                    media: [{
                        id: 'tracking-media',
                        url: 'https://remote.example/unique-viewer-pixel.gif',
                        mimeType: 'image/gif',
                    }],
                    linkPreviewImage: 'https://remote.example/preview-tracker.gif',
                    linkPreviewMedia: [{ url: 'https://remote.example/gallery-tracker.gif' }],
                },
            }));

            expect(html).toContain('A remote post');
            expect(html).not.toContain('unique-viewer-pixel.gif');
            expect(html).not.toContain('src="https://remote.example/preview-tracker.gif"');
            expect(html).not.toContain('src="https://remote.example/gallery-tracker.gif"');
            expect(html).toContain('/api/media/preview/image?url=');
            expect(html).not.toContain('aria-label="Download media"');
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('requires a pre-existing adult-node member to confirm their age', () => {
        mocks.nodeIsNsfw = true;
        mocks.user = {
            id: 'viewer-1',
            handle: 'viewer',
            displayName: 'Viewer',
            nsfwEnabled: false,
            ageVerifiedAt: null,
        };

        const html = renderToStaticMarkup(createElement(PostCard, { post: sensitivePost }));

        expect(html).toContain('Review settings');
        expect(html).toContain('Sensitive content');
        expect(html).not.toContain('PRIVATE SENSITIVE BODY');
        expect(html).not.toContain('private-video.mp4');
    });

    it('shows adult-node content after the member confirms their age', () => {
        mocks.nodeIsNsfw = true;
        mocks.user = {
            id: 'viewer-1',
            handle: 'viewer',
            displayName: 'Viewer',
            nsfwEnabled: false,
            ageVerifiedAt: '2026-07-17T00:00:00.000Z',
        };

        const html = renderToStaticMarkup(createElement(PostCard, { post: sensitivePost }));

        expect(html).not.toContain('Review settings');
        expect(html).not.toContain('Sensitive content');
        expect(html).toContain('PRIVATE SENSITIVE BODY');
    });
});
