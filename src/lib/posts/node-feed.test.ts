import { describe, expect, it } from 'vitest';
import {
    assembleNodeFeedStories,
    collapseSharedFeedPosts,
    dedupeReposters,
    mergeNodeFeedActivities,
    setReposterInSummary,
    type NodeFeedReposter,
} from './node-feed';
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

    it('preserves preassembled federated reposters on an original story', () => {
        const original = post('original', user('author'), '2026-07-16T12:00:00Z', {
            repostsCount: 1,
            repostedBy: [user('remote-reposter')],
            repostedByCount: 1,
            feedActivityAt: '2026-07-16T15:00:00Z',
        });

        const [result] = collapseSharedFeedPosts([original]);

        expect(result.repostedBy?.map((reposter) => reposter.id)).toEqual(['remote-reposter']);
        expect(result.feedActivityAt).toBe('2026-07-16T15:00:00.000Z');
    });

    it('collapses local and federated IDs for the same reposter identity', () => {
        const localViewer = {
            ...user('viewer'),
            nodeDomain: 'synapsis.social',
        };
        const federatedViewer = {
            ...user('swarm:synapsis.social:viewer'),
            handle: 'viewer@synapsis.social',
            nodeDomain: 'synapsis.social',
        };
        const original = post('original', user('author'), '2026-07-16T12:00:00Z', {
            repostsCount: 1,
            repostedBy: [federatedViewer],
            repostedByCount: 1,
        });
        const repost = post('repost', localViewer, '2026-07-16T13:00:00Z', { repostOf: original });

        const localReposterWithoutDomain = { ...localViewer, nodeDomain: undefined };
        const localRepost = { ...repost, author: localReposterWithoutDomain };
        const [result] = collapseSharedFeedPosts([original, localRepost], 'synapsis.social');

        expect(result.repostedBy).toHaveLength(1);
        expect(result.repostedByCount).toBe(1);
    });
});

describe('dedupeReposters', () => {
    it('uses the qualified handle and node when IDs differ', () => {
        const result = dedupeReposters([
            { ...user('local-id'), handle: 'alice', nodeDomain: 'Example.COM' },
            { ...user('swarm:example.com:alice'), handle: 'alice@example.com', nodeDomain: 'example.com' },
            { ...user('other-node-id'), handle: 'alice@other.example', nodeDomain: 'other.example' },
        ]);

        expect(result.map((reposter) => reposter.id)).toEqual(['local-id', 'other-node-id']);
    });
});

describe('mergeNodeFeedActivities', () => {
    it('uses a remote repost as the latest story activity without duplicating the post', () => {
        const result = mergeNodeFeedActivities([
            [
                { storyId: 'post-1', latestActivityAt: new Date('2026-07-16T12:00:00Z') },
                { storyId: 'post-2', latestActivityAt: new Date('2026-07-16T14:00:00Z') },
            ],
            [{ storyId: 'post-1', latestActivityAt: new Date('2026-07-16T15:00:00Z') }],
        ], 2);

        expect(result).toEqual([
            { storyId: 'post-1', latestActivityAt: new Date('2026-07-16T15:00:00Z') },
            { storyId: 'post-2', latestActivityAt: new Date('2026-07-16T14:00:00Z') },
        ]);
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

describe('setReposterInSummary', () => {
    it('adds the viewer first without inflating an existing total', () => {
        const viewer = user('viewer');
        const result = setReposterInSummary([user('alice'), user('bob')], 5, viewer, true);

        expect(result.repostedBy.map((reposter) => reposter.id)).toEqual(['viewer', 'alice', 'bob']);
        expect(result.repostedByCount).toBe(5);
    });

    it('replaces stale viewer metadata and never duplicates their avatar', () => {
        const staleViewer = { ...user('viewer'), avatarUrl: '/old-avatar.png' };
        const freshViewer = { ...user('viewer'), avatarUrl: '/new-avatar.png' };
        const result = setReposterInSummary(
            [user('alice'), staleViewer, user('bob')],
            3,
            freshViewer,
            true,
        );

        expect(result.repostedBy.map((reposter) => reposter.id)).toEqual(['viewer', 'alice', 'bob']);
        expect(result.repostedBy[0].avatarUrl).toBe('/new-avatar.png');
        expect(result.repostedByCount).toBe(3);
    });

    it('replaces the federated form of the viewer instead of adding a second avatar', () => {
        const viewer = { ...user('viewer-id'), handle: 'viewer', nodeDomain: 'synapsis.social' };
        const federatedViewer = {
            ...user('swarm:synapsis.social:viewer'),
            handle: 'viewer@synapsis.social',
            nodeDomain: 'synapsis.social',
        };

        const result = setReposterInSummary([federatedViewer], 1, viewer, true);

        expect(result).toEqual({
            repostedBy: [viewer],
            repostedByCount: 1,
        });
    });

    it('removes the viewer while preserving other reposters and the supplied total', () => {
        const result = setReposterInSummary(
            [user('viewer'), user('alice')],
            1,
            user('viewer'),
            false,
        );

        expect(result).toEqual({
            repostedBy: [user('alice')],
            repostedByCount: 1,
        });
    });
});
