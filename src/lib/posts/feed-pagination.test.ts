import { describe, expect, it } from 'vitest';
import { decodeFeedCursor, encodeFeedCursor } from './feed-pagination';

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
});
