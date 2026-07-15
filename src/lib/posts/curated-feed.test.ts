import { describe, expect, it } from 'vitest';
import type { Post } from '@/lib/types';
import { rankCuratedFeed } from './curated-feed';

const NOW = Date.parse('2026-07-15T20:00:00Z');

function post(
  id: string,
  author: string,
  nodeDomain: string,
  ageHours: number,
  options: Partial<Post> = {},
): Post {
  return {
    id,
    content: id,
    createdAt: new Date(NOW - ageHours * 3_600_000).toISOString(),
    likesCount: 0,
    repostsCount: 0,
    repliesCount: 0,
    author: {
      id: `${nodeDomain}:${author}`,
      handle: author,
      displayName: author,
      nodeDomain,
    },
    nodeDomain,
    ...options,
  };
}

describe('rankCuratedFeed', () => {
  it('spreads authors instead of preserving a mostly chronological run', () => {
    const ranked = rankCuratedFeed([
      post('a-newest', 'alice', 'one.social', 0),
      post('a-second', 'alice', 'one.social', 1),
      post('a-third', 'alice', 'one.social', 2),
      post('b', 'bob', 'one.social', 3),
      post('c', 'carol', 'two.social', 4),
    ], { now: NOW, limit: 5 });

    expect(ranked[0].id).toBe('a-newest');
    expect(ranked.slice(0, 3).map((item) => item.author.handle)).toEqual(['alice', 'carol', 'bob']);
  });

  it('mixes nodes and formats when candidates have similar relevance', () => {
    const ranked = rankCuratedFeed([
      post('one-text', 'alice', 'one.social', 0),
      post('one-text-2', 'bob', 'one.social', 1),
      post('two-media', 'carol', 'two.social', 2, {
        media: [{ id: 'media', url: 'https://stuffbox.xyz/media' }],
      }),
      post('three-link', 'dave', 'three.social', 3, {
        linkPreviewUrl: 'https://example.org/story',
      }),
    ], { now: NOW, limit: 4 });

    expect(ranked.slice(0, 3).map((item) => item.nodeDomain)).toEqual([
      'one.social',
      'two.social',
      'three.social',
    ]);
    expect(ranked[1].feedMeta.reasons).toContain('A different community');
    expect(ranked[1].feedMeta.reasons).toContain('A different kind of post');
  });

  it('inserts a different voice between highly engaged posts from the same source', () => {
    const ranked = rankCuratedFeed([
      post('viral-one', 'alice', 'one.social', 1, { likesCount: 100 }),
      post('viral-two', 'alice', 'one.social', 2, { likesCount: 100 }),
      post('quiet', 'bob', 'two.social', 4),
    ], { now: NOW, limit: 3 });

    expect(ranked.map((item) => item.id)).toEqual(['viral-one', 'quiet', 'viral-two']);
    expect(ranked[2].feedMeta.diversity.authorPenalty).toBeGreaterThan(0);
  });

  it('is deterministic for the same candidate pool and time', () => {
    const candidates = [
      post('a', 'alice', 'one.social', 1),
      post('b', 'bob', 'two.social', 1),
      post('c', 'carol', 'three.social', 1),
    ];

    expect(rankCuratedFeed(candidates, { now: NOW }).map((item) => item.id)).toEqual(
      rankCuratedFeed(candidates, { now: NOW }).map((item) => item.id),
    );
  });
});
