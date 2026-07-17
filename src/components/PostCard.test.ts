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
        url: 'https://local.example/private-video.mp4',
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
