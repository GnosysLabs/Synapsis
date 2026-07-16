import { describe, expect, it } from 'vitest';
import { assembleNodeFeedStories, collapseSharedFeedPosts, type NodeFeedReposter } from './node-feed';
import type { Post, User } from '@/lib/types';

const actor = (id: string): NodeFeedReposter => ({
    id,
    handle: id,
    displayName: id.toUpperCase(),
    avatarUrl: null,
    isNsfw: false,
});

const user = (id: string): User => ({ id, handle: id, displayName: id.toUpperCase() });

const post = (id: string, author: User, createdAt: string, overrides: Partial<Post> = {}): Post => ({
    id,
    author,
    content: id,
    createdAt,
    likesCount: 0,
    repostsCount: 0,
    repliesCount: 0,
    ...overrides,
});

describe('collapseSharedFeedPosts', () => {
    it('resurfaces one original card with multiple reposter avatars', () => {
        const original = post('original', user('author'), '2026-07-16T12:00:00Z', { repostsCount: 5 });
        const firstRepost = post('repost-1', user('alice'), '2026-07-16T14:00:00Z', { repostOf: original });
        const latestRepost = post('repost-2', user('bob'), '2026-07-16T15:00:00Z', { repostOf: original });

        const result = collapseSharedFeedPosts([original, firstRepost, latestRepost]);

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            id: original.id,
            feedActivityAt: '2026-07-16T15:00:00.000Z',
            repostedByCount: 5,
        });
        expect(result[0].repostedBy?.map((reposter) => reposter.id)).toEqual(['bob', 'alice']);
    });

    it('leaves ordinary posts independent and orders them by latest activity', () => {
        const older = post('older', user('author'), '2026-07-16T12:00:00Z');
        const newer = post('newer', user('author'), '2026-07-16T13:00:00Z');

        expect(collapseSharedFeedPosts([older, newer]).map((item) => item.id)).toEqual(['newer', 'older']);
    });
});

describe('assembleNodeFeedStories', () => {
    it('returns an original post once with all unique reposters attached', () => {
        const original = { id: 'post-1', content: 'Original post' };
        const result = assembleNodeFeedStories(
            [{ storyId: original.id, latestActivityAt: new Date('2026-07-16T15:00:00Z') }],
            [original],
            [
                { repostOfId: original.id, author: actor('alice') },
                { repostOfId: original.id, author: actor('bob') },
                { repostOfId: original.id, author: actor('alice') },
            ],
        );

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            id: original.id,
            content: original.content,
            feedActivityAt: '2026-07-16T15:00:00.000Z',
            repostedByCount: 2,
        });
        expect(result[0].repostedBy.map((reposter) => reposter.id)).toEqual(['alice', 'bob']);
    });

    it('preserves activity order and omits wrapper rows whose original is unavailable', () => {
        const result = assembleNodeFeedStories(
            [
                { storyId: 'newly-resurfaced', latestActivityAt: new Date('2026-07-16T16:00:00Z') },
                { storyId: 'missing', latestActivityAt: new Date('2026-07-16T15:30:00Z') },
                { storyId: 'new-post', latestActivityAt: new Date('2026-07-16T15:00:00Z') },
            ],
            [
                { id: 'newly-resurfaced', content: 'Older original' },
                { id: 'new-post', content: 'New post' },
            ],
            [{ repostOfId: 'newly-resurfaced', author: actor('alice') }],
        );

        expect(result.map((post) => post.id)).toEqual(['newly-resurfaced', 'new-post']);
    });
});
