import { describe, expect, it } from 'vitest';
import {
  decodeFeedCursor,
  encodeFeedCursor,
  getSourceContinuationDate,
  newestDate,
  selectFeedWindow,
} from './feed-pagination';

describe('feed pagination cursors', () => {
  it('round-trips a post timestamp', () => {
    const timestamp = '2026-07-15T08:30:12.345Z';
    const cursor = encodeFeedCursor(timestamp);

    expect(cursor).toBe('feed:1784104212345');
    expect(decodeFeedCursor(cursor)?.toISOString()).toBe(timestamp);
  });

  it('rejects IDs and malformed cursors', () => {
    expect(decodeFeedCursor('swarm:example.com:post-id')).toBeNull();
    expect(decodeFeedCursor('feed:not-a-number')).toBeNull();
    expect(encodeFeedCursor('not-a-date')).toBeNull();
  });

  it('selects a chronological activity window before any relevance reordering', () => {
    const result = selectFeedWindow([
      { id: 'old-original', createdAt: '2026-07-10T00:00:00Z', feedActivityAt: '2026-07-15T12:00:00Z' },
      { id: 'middle', createdAt: '2026-07-15T11:00:00Z' },
      { id: 'newest', createdAt: '2026-07-15T13:00:00Z' },
    ], 2);

    expect(result.posts.map((post) => post.id)).toEqual(['newest', 'old-original']);
    expect(result.hasOverflow).toBe(true);
    expect(result.oldestActivityAt?.toISOString()).toBe('2026-07-15T12:00:00.000Z');
  });

  it('continues from the busy source without skipping behind an older exhausted source', () => {
    const continuation = getSourceContinuationDate([
      { posts: [
        { createdAt: '2026-07-15T15:00:00Z' },
        { createdAt: '2026-07-15T14:00:00Z' },
      ] },
      { posts: [{ createdAt: '2026-07-01T00:00:00Z' }] },
      { posts: [
        { createdAt: '2026-07-15T13:00:00Z' },
        { createdAt: '2026-07-15T12:00:00Z' },
      ] },
    ], 2);

    expect(continuation?.toISOString()).toBe('2026-07-15T14:00:00.000Z');
  });

  it('continues from repost activity rather than the original publication time', () => {
    const continuation = getSourceContinuationDate([{ posts: [
      {
        createdAt: '2026-07-10T00:00:00Z',
        feedActivityAt: '2026-07-16T15:00:00Z',
      },
      { createdAt: '2026-07-16T14:00:00Z' },
    ] }], 2);

    expect(continuation?.toISOString()).toBe('2026-07-16T14:00:00.000Z');
  });

  it('combines continuation boundaries using the newest safe cutoff', () => {
    expect(newestDate([
      new Date('2026-07-15T10:00:00Z'),
      null,
      new Date('2026-07-15T12:00:00Z'),
    ])?.toISOString()).toBe('2026-07-15T12:00:00.000Z');
  });
});
