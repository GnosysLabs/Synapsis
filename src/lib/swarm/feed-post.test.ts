import { describe, expect, it } from 'vitest';
import type { SwarmPost } from '@/app/api/swarm/timeline/route';
import { mapSwarmPostToPost } from './feed-post';

const original: SwarmPost = {
    id: 'original-id',
    content: 'Original post body',
    createdAt: '2026-07-15T18:49:15.000Z',
    author: {
        handle: 'original-author',
        displayName: 'Original Author',
        avatarUrl: 'https://example.com/original.png',
        isNsfw: false,
    },
    nodeDomain: 'remote.example',
    nodeIsNsfw: true,
    isNsfw: false,
    likeCount: 2,
    repostCount: 1,
    replyCount: 0,
    media: [{ url: 'https://example.com/image.jpg', mimeType: 'image/jpeg' }],
};

describe('mapSwarmPostToPost', () => {
    it('preserves the complete embedded original when mapping a repost', () => {
        const repost: SwarmPost = {
            id: 'repost-id',
            content: '',
            createdAt: '2026-07-15T20:07:48.000Z',
            repostOfId: original.id,
            repostOf: original,
            author: {
                handle: 'reposter',
                displayName: 'Reposter',
                isNsfw: false,
            },
            nodeDomain: 'remote.example',
            nodeIsNsfw: true,
            isNsfw: false,
            likeCount: 0,
            repostCount: 0,
            replyCount: 0,
        };

        const mapped = mapSwarmPostToPost(repost);

        expect(mapped.repostOfId).toBe('swarm:remote.example:original-id');
        expect(mapped.repostOf).toMatchObject({
            id: 'swarm:remote.example:original-id',
            content: 'Original post body',
            nodeDomain: 'remote.example',
            author: {
                handle: 'original-author@remote.example',
                nodeIsNsfw: true,
            },
            media: [{
                id: 'swarm:remote.example:original-id:media:0',
                url: 'https://example.com/image.jpg',
                mimeType: 'image/jpeg',
            }],
        });
    });

    it('qualifies a bare swarm author handle with its node domain', () => {
        const mapped = mapSwarmPostToPost(original);

        expect(mapped.author.handle).toBe('original-author@remote.example');
    });

    it('preserves interaction and link-preview fields', () => {
        const mapped = mapSwarmPostToPost({
            ...original,
            isLiked: true,
            isReposted: true,
            linkPreviewUrl: 'https://example.com/story',
            linkPreviewTitle: 'Story',
            linkPreviewType: 'card',
        });

        expect(mapped).toMatchObject({
            isLiked: true,
            isReposted: true,
            linkPreviewUrl: 'https://example.com/story',
            linkPreviewTitle: 'Story',
            linkPreviewType: 'card',
        });
    });
});
