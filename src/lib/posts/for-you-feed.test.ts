import { describe, expect, it } from 'vitest';
import type { Post } from '@/lib/types';
import {
  emptyForYouDiversityState,
  rankForYouFeed,
  type ForYouViewerSignals,
} from './for-you-feed';

const NOW = Date.parse('2026-07-20T20:00:00Z');

function post(id: string, author: string, nodeDomain: string, ageHours: number): Post {
  return {
    id,
    content: `${id} distributed software photography`,
    createdAt: new Date(NOW - ageHours * 3_600_000).toISOString(),
    likesCount: 100_000,
    repostsCount: 100_000,
    repliesCount: 100_000,
    author: {
      id: `${nodeDomain}:${author}`,
      handle: `${author}@${nodeDomain}`,
      displayName: author,
      nodeDomain,
    },
    nodeDomain,
  };
}

function signals(overrides: Partial<ForYouViewerSignals> = {}): ForYouViewerSignals {
  return {
    viewerHandle: 'viewer@local.social',
    localNodeDomain: 'local.social',
    followedAuthors: new Set(),
    authorAffinity: new Map(),
    authorDisinterest: new Map(),
    postEngagement: new Map(),
    socialEngagement: new Map(),
    seenPosts: new Map(),
    negativePosts: new Set(),
    topicWeights: new Map(),
    negativeTopicWeights: new Map(),
    personalizationConfidence: 0,
    ...overrides,
  };
}

describe('rankForYouFeed', () => {
  it('uses only locally observed engagement rather than federated raw totals', () => {
    const quiet = post('quiet', 'alice', 'one.social', 2);
    quiet.likesCount = 0;
    quiet.repostsCount = 0;
    quiet.repliesCount = 0;
    const claimedViral = post('claimed-viral', 'bob', 'two.social', 2);

    const result = rankForYouFeed([quiet, claimedViral], signals({
      postEngagement: new Map([['quiet', { likes: 8, reposts: 2, replies: 3 }]]),
    }), { limit: 2, snapshotAt: NOW });

    expect(result.posts[0].id).toBe('quiet');
  });

  it('personalizes from follows, author affinity, social proof, and topics', () => {
    const familiar = post('familiar', 'alice', 'one.social', 4);
    familiar.content = 'distributed databases and federation';
    const stranger = post('stranger', 'bob', 'two.social', 4);
    stranger.content = 'gardening';

    const result = rankForYouFeed([stranger, familiar], signals({
      followedAuthors: new Set(['alice@one.social']),
      authorAffinity: new Map([['alice@one.social', 7]]),
      socialEngagement: new Map([['familiar', { likes: 2, reposts: 1, replies: 0 }]]),
      topicWeights: new Map([['distributed', 5], ['federation', 4]]),
      personalizationConfidence: 0.9,
    }), { limit: 2, snapshotAt: NOW });

    expect(result.posts[0].id).toBe('familiar');
    expect(result.posts[0].feedMeta.reasons).toContain('From someone you follow');
    expect(result.posts[0].feedMeta.reasons).toContain('Matches topics you engage with');
  });

  it('strongly suppresses recent impressions and removes explicit negative feedback', () => {
    const seen = post('seen', 'alice', 'one.social', 1);
    const unseen = post('unseen', 'bob', 'two.social', 5);
    const rejected = post('rejected', 'carol', 'three.social', 0);
    const result = rankForYouFeed([seen, unseen, rejected], signals({
      seenPosts: new Map([['seen', { count: 3, lastSeenAt: new Date(NOW - 60_000) }]]),
      negativePosts: new Set(['rejected']),
      personalizationConfidence: 0.5,
    }), { limit: 3, snapshotAt: NOW });

    expect(result.posts.map((candidate) => candidate.id)).toEqual(['unseen', 'seen']);
    expect(result.posts.some((candidate) => candidate.id === 'rejected')).toBe(false);
  });

  it('uses negative feedback to down-rank related authors and topics', () => {
    const similar = post('similar', 'alice', 'one.social', 2);
    similar.content = 'cryptocurrency token trading';
    const alternative = post('alternative', 'bob', 'two.social', 3);
    alternative.content = 'landscape photography';
    const result = rankForYouFeed([similar, alternative], signals({
      authorDisinterest: new Map([['alice@one.social', 2]]),
      negativeTopicWeights: new Map([['cryptocurrency', 3], ['token', 3], ['trading', 3]]),
      personalizationConfidence: 0.6,
    }), { limit: 2, snapshotAt: NOW });

    expect(result.posts[0].id).toBe('alternative');
    expect(result.posts[1].feedMeta.signals.negative).toBeGreaterThan(0);
  });

  it('carries author and node diversity across page boundaries', () => {
    const candidates = [
      post('alice-1', 'alice', 'one.social', 1),
      post('alice-2', 'alice', 'one.social', 1.1),
      post('alice-3', 'alice', 'one.social', 1.2),
      post('bob', 'bob', 'two.social', 2),
      post('carol', 'carol', 'three.social', 2.2),
    ];
    const first = rankForYouFeed(candidates, signals(), { limit: 2, snapshotAt: NOW });
    const served = new Set(first.posts.map((candidate) => candidate.id));
    const second = rankForYouFeed(
      candidates.filter((candidate) => !served.has(candidate.id)),
      signals(),
      { limit: 2, snapshotAt: NOW, state: first.state },
    );

    expect(new Set([...first.posts, ...second.posts].map((candidate) => candidate.author.handle)).size)
      .toBeGreaterThanOrEqual(3);
  });

  it('eventually returns the entire corpus with no 100 or 200 candidate ceiling', () => {
    const candidates = Array.from({ length: 237 }, (_, index) => (
      post(`post-${index}`, `author-${index % 17}`, `node-${index % 11}.social`, index * 2)
    ));
    const served = new Set<string>();
    let state = emptyForYouDiversityState();

    while (served.size < candidates.length) {
      const page = rankForYouFeed(
        candidates.filter((candidate) => !served.has(candidate.id)),
        signals(),
        { limit: 20, snapshotAt: NOW, state },
      );
      expect(page.posts.length).toBeGreaterThan(0);
      page.posts.forEach((candidate) => served.add(candidate.id));
      state = page.state;
    }

    expect(served.size).toBe(237);
  });

  it('is deterministic for a fixed viewer, snapshot, and corpus', () => {
    const candidates = [
      post('a', 'alice', 'one.social', 1),
      post('b', 'bob', 'two.social', 1),
      post('c', 'carol', 'three.social', 1),
    ];
    const first = rankForYouFeed(candidates, signals(), { limit: 3, snapshotAt: NOW });
    const second = rankForYouFeed(candidates, signals(), { limit: 3, snapshotAt: NOW });
    expect(first.posts.map((candidate) => candidate.id))
      .toEqual(second.posts.map((candidate) => candidate.id));
  });
});
