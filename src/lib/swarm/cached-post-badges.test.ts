import { describe, expect, it } from 'vitest';
import type { Post, StuffboxBadge } from '@/lib/types';
import { applyCachedStuffboxBadges } from './cached-post-badges';

const supporterBadge: StuffboxBadge = {
  level: 'supporter',
  plan: 'mini',
  issuer: 'https://stuffbox.xyz',
  attestation: 'verified-attestation',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

describe('applyCachedStuffboxBadges', () => {
  it('repairs the original author badge inside a durable repost snapshot', () => {
    const original: Post = {
      id: 'swarm:origin.example:post-1',
      originalPostId: 'post-1',
      nodeDomain: 'origin.example',
      content: 'Original',
      createdAt: '2026-07-21T00:00:00.000Z',
      likesCount: 0,
      repostsCount: 1,
      repliesCount: 0,
      author: {
        id: 'swarm:origin.example:alice',
        handle: 'alice@origin.example',
        displayName: 'Alice',
      },
    };
    const repost: Post = {
      id: 'swarm-repost:local-1',
      content: '',
      createdAt: '2026-07-21T01:00:00.000Z',
      likesCount: 0,
      repostsCount: 0,
      repliesCount: 0,
      author: {
        id: 'local-user',
        handle: 'local@local.example',
        displayName: 'Local',
      },
      repostOf: original,
    };

    const [result] = applyCachedStuffboxBadges(
      [repost],
      new Map([['origin.example\u0000post-1', supporterBadge]]),
    );

    expect(result.repostOf?.author.stuffboxBadge).toEqual(supporterBadge);
    expect(result.author.stuffboxBadge).toBeUndefined();
  });
});
