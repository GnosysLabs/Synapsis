import { describe, expect, it } from 'vitest';
import { parseRemoteTimelineResponse } from './remote-timeline-payload';

function post(overrides: Record<string, unknown> = {}) {
  return {
    id: 'post-1',
    content: 'Hello',
    createdAt: new Date().toISOString(),
    author: { handle: 'alice', displayName: 'Alice', isNsfw: false },
    nodeDomain: 'source.social',
    nodeIsNsfw: false,
    isNsfw: false,
    likeCount: 0,
    repostCount: 0,
    replyCount: 0,
    ...overrides,
  };
}

describe('remote timeline payload validation', () => {
  it('accepts a bounded post from the contacted origin', () => {
    const result = parseRemoteTimelineResponse({
      posts: [post()],
      nodeDomain: 'source.social',
      nodeIsNsfw: false,
    }, 'source.social');
    expect(result.posts).toHaveLength(1);
  });

  it('rejects cross-domain identity claims and future ranking timestamps', () => {
    expect(() => parseRemoteTimelineResponse({
      posts: [post({ nodeDomain: 'victim.social' })],
    }, 'source.social')).toThrow(/different node origin/);
    expect(() => parseRemoteTimelineResponse({
      posts: [post({ createdAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString() })],
    }, 'source.social')).toThrow(/future-dated/);
  });

  it('rejects unbounded post arrays and strips deeper recursive payloads', () => {
    expect(() => parseRemoteTimelineResponse({
      posts: Array.from({ length: 51 }, (_, index) => post({ id: `post-${index}` })),
    }, 'source.social')).toThrow(/failed validation/);

    const recursive = post({
      repostOf: post({ repostOf: post() }),
    });
    const parsed = parseRemoteTimelineResponse({ posts: [recursive] }, 'source.social');
    expect((parsed.posts[0].repostOf as unknown as { repostOf?: unknown }).repostOf).toBeUndefined();
  });
});
