import { describe, expect, it, vi } from 'vitest';
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
    expect(result.posts[0].author.handle).toBe('alice@source.social');
  });

  it('rejects cross-domain identity claims and future ranking timestamps', () => {
    expect(() => parseRemoteTimelineResponse({
      posts: [post({ nodeDomain: 'victim.social' })],
    }, 'source.social')).toThrow(/different node origin/);
    expect(() => parseRemoteTimelineResponse({
      posts: [post({ createdAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString() })],
    }, 'source.social')).toThrow(/future-dated/);
  });

  it('drops cross-node reposter claims and rewrites source-owned identities', () => {
    const result = parseRemoteTimelineResponse({
      posts: [post({
        repostedBy: [
          {
            id: 'forged-victim-id',
            handle: 'admin@victim.social',
            displayName: 'Victim Admin',
            nodeDomain: 'victim.social',
          },
          {
            id: 'attacker-controlled-id',
            handle: 'alice@source.social',
            displayName: 'Alice',
            nodeDomain: 'source.social',
          },
        ],
      })],
    }, 'source.social');

    expect(result.posts[0].repostedBy).toEqual([expect.objectContaining({
      id: 'swarm:source.social:alice',
      handle: 'alice@source.social',
      nodeDomain: 'source.social',
      isRemote: true,
      isSwarm: true,
    })]);
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

  it('never accepts peer-hosted tracking media in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(() => parseRemoteTimelineResponse({
        posts: [post({
          media: [{ url: 'https://source.social/unique-viewer-pixel.gif' }],
        })],
      }, 'source.social')).toThrow(/failed validation/);

      expect(parseRemoteTimelineResponse({
        posts: [post({
          media: [{ url: 'https://cdn.stuffbox.xyz/assets/photo.jpg' }],
        })],
      }, 'source.social').posts).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('accepts public preview artwork for same-origin proxying', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const result = parseRemoteTimelineResponse({
        posts: [post({
          linkPreviewUrl: 'https://pcgamer.com/story',
          linkPreviewTitle: 'Example story',
          linkPreviewImage: 'https://cdn.mos.cms.futurecdn.net/story.jpg',
          linkPreviewMedia: [{ url: 'https://cdn.mos.cms.futurecdn.net/story.jpg' }],
        })],
      }, 'source.social');

      expect(result.posts[0].linkPreviewImage).toBe('https://cdn.mos.cms.futurecdn.net/story.jpg');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('accepts bounded tombstones and rejects mismatched upsert identities', () => {
    const parsed = parseRemoteTimelineResponse({
      posts: [],
      changes: [{
        sequence: 8,
        type: 'delete',
        postId: 'post-8',
        changedAt: new Date().toISOString(),
      }],
      changeCursor: 8,
    }, 'source.social');
    expect(parsed.changes).toEqual([expect.objectContaining({
      type: 'delete',
      postId: 'post-8',
    })]);

    expect(() => parseRemoteTimelineResponse({
      posts: [],
      changes: [{
        sequence: 9,
        type: 'upsert',
        postId: 'different-id',
        changedAt: new Date().toISOString(),
        post: post({ id: 'post-9' }),
      }],
    }, 'source.social')).toThrow(/identity mismatch/);
  });

  it('accepts bounded account deletions and rejects future-dated ones', () => {
    const deletedAt = new Date().toISOString();
    const parsed = parseRemoteTimelineResponse({
      posts: [],
      accountChanges: [{
        sequence: 11,
        handle: 'alice',
        did: 'did:key:alice-deleted-identity',
        deletedAt,
      }],
      accountChangeCursor: 11,
    }, 'source.social');
    expect(parsed.accountChanges).toEqual([{
      sequence: 11,
      handle: 'alice@source.social',
      did: 'did:key:alice-deleted-identity',
      deletedAt,
    }]);

    expect(() => parseRemoteTimelineResponse({
      posts: [],
      accountChanges: [{
        sequence: 12,
        handle: 'alice',
        did: 'did:key:alice-deleted-identity',
        deletedAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
      }],
    }, 'source.social')).toThrow(/future-dated account deletion/);
  });
});
