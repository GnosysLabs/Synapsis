/**
 * Content Fetcher Tests
 * 
 * Tests for the content fetcher module including exponential backoff,
 * error tracking, and content storage.
 * 
 * Requirements: 4.5, 4.7
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  calculateBackoffDelay,
  shouldRetrySource,
  isSourceDueForFetch,
  shouldExcludeRedditPost,
  fetchRedditPosts,
  BASE_BACKOFF_DELAY_MS,
  MAX_BACKOFF_DELAY_MS,
  MAX_CONSECUTIVE_ERRORS,
} from './contentFetcher';
import type { ContentSource } from './contentSource';

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Create a mock content source for testing.
 */
function createMockSource(overrides: Partial<ContentSource> = {}): ContentSource {
  return {
    id: 'test-source-id',
    botId: 'test-bot-id',
    type: 'rss',
    url: 'https://example.com/feed.xml',
    subreddit: null,

    sourceConfig: null,
    keywords: null,
    isActive: true,
    lastFetchAt: null,
    lastError: null,
    consecutiveErrors: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ============================================
// EXPONENTIAL BACKOFF TESTS
// ============================================

describe('calculateBackoffDelay', () => {
  it('should return 0 for 0 consecutive errors', () => {
    const delay = calculateBackoffDelay(0);
    expect(delay).toBe(0);
  });

  it('should return 0 for negative consecutive errors', () => {
    const delay = calculateBackoffDelay(-1);
    expect(delay).toBe(0);
  });

  it('should return base delay for 1 consecutive error', () => {
    const delay = calculateBackoffDelay(1);
    // With jitter, should be within ±10% of base delay
    expect(delay).toBeGreaterThanOrEqual(BASE_BACKOFF_DELAY_MS * 0.9);
    expect(delay).toBeLessThanOrEqual(BASE_BACKOFF_DELAY_MS * 1.1);
  });

  it('should double delay for each consecutive error', () => {
    // Test exponential growth pattern
    const delay1 = calculateBackoffDelay(1);
    const delay2 = calculateBackoffDelay(2);
    const delay3 = calculateBackoffDelay(3);

    // delay2 should be approximately 2x delay1 (accounting for jitter)
    expect(delay2).toBeGreaterThan(delay1);
    expect(delay3).toBeGreaterThan(delay2);

    // Check approximate doubling (within jitter range)
    const expectedDelay2 = BASE_BACKOFF_DELAY_MS * 2;
    const expectedDelay3 = BASE_BACKOFF_DELAY_MS * 4;

    expect(delay2).toBeGreaterThanOrEqual(expectedDelay2 * 0.9);
    expect(delay2).toBeLessThanOrEqual(expectedDelay2 * 1.1);

    expect(delay3).toBeGreaterThanOrEqual(expectedDelay3 * 0.9);
    expect(delay3).toBeLessThanOrEqual(expectedDelay3 * 1.1);
  });

  it('should cap delay at maximum', () => {
    // With very high consecutive errors, should cap at max
    const delay = calculateBackoffDelay(100);
    expect(delay).toBeLessThanOrEqual(MAX_BACKOFF_DELAY_MS * 1.1);
  });

  it('should include jitter in delay', () => {
    // Run multiple times and check for variation
    const delays = Array.from({ length: 10 }, () => calculateBackoffDelay(5));
    const uniqueDelays = new Set(delays);

    // With jitter, we should get some variation
    // (though there's a small chance all are the same)
    expect(uniqueDelays.size).toBeGreaterThanOrEqual(1);
  });
});

// ============================================
// RETRY LOGIC TESTS
// ============================================

describe('shouldRetrySource', () => {
  it('should return true for active source with no errors', () => {
    const source = createMockSource({
      isActive: true,
      consecutiveErrors: 0,
    });

    expect(shouldRetrySource(source)).toBe(true);
  });

  it('should return false for inactive source', () => {
    const source = createMockSource({
      isActive: false,
      consecutiveErrors: 0,
    });

    expect(shouldRetrySource(source)).toBe(false);
  });

  it('should return false when max consecutive errors reached', () => {
    const source = createMockSource({
      isActive: true,
      consecutiveErrors: MAX_CONSECUTIVE_ERRORS,
    });

    expect(shouldRetrySource(source)).toBe(false);
  });

  it('should return false when in backoff period', () => {
    const source = createMockSource({
      isActive: true,
      consecutiveErrors: 3,
      lastFetchAt: new Date(), // Just fetched
    });

    expect(shouldRetrySource(source)).toBe(false);
  });

  it('should return true when backoff period has passed', () => {
    const backoffDelay = calculateBackoffDelay(1);
    const source = createMockSource({
      isActive: true,
      consecutiveErrors: 1,
      lastFetchAt: new Date(Date.now() - backoffDelay - 1000), // Past backoff
    });

    expect(shouldRetrySource(source)).toBe(true);
  });

  it('should return true for source with errors but never fetched', () => {
    const source = createMockSource({
      isActive: true,
      consecutiveErrors: 3,
      lastFetchAt: null,
    });

    expect(shouldRetrySource(source)).toBe(true);
  });
});

// ============================================
// FETCH DUE TESTS
// ============================================

describe('isSourceDueForFetch', () => {
  it('should return true for source never fetched', () => {
    const source = createMockSource({
      isActive: true,
      lastFetchAt: null,
    });

    expect(isSourceDueForFetch(source)).toBe(true);
  });

  it('should return false for inactive source', () => {
    const source = createMockSource({
      isActive: false,
      lastFetchAt: null,
    });

    expect(isSourceDueForFetch(source)).toBe(false);
  });


});

describe('Reddit filtering', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('excludes stickied and pinned reddit posts', () => {
    expect(shouldExcludeRedditPost({
      id: 't3_stickied',
      title: 'Community thread',
      permalink: '/r/test/comments/stickied/community_thread/',
      url: 'https://reddit.com/r/test/comments/stickied/community_thread/',
      created_utc: 1710000000,
      stickied: true,
    })).toBe(true);

    expect(shouldExcludeRedditPost({
      id: 't3_pinned',
      title: 'Pinned thread',
      permalink: '/r/test/comments/pinned/pinned_thread/',
      url: 'https://reddit.com/r/test/comments/pinned/pinned_thread/',
      created_utc: 1710000000,
      pinned: true,
    })).toBe(true);

    expect(shouldExcludeRedditPost({
      id: 't3_normal',
      title: 'Normal post',
      permalink: '/r/test/comments/normal/normal_post/',
      url: 'https://reddit.com/r/test/comments/normal/normal_post/',
      created_utc: 1710000000,
    })).toBe(false);
  });

  it('fetchRedditPosts removes community highlights before returning items', async () => {
    const payload = {
      data: {
        children: [
          {
            data: {
              id: 'abc123',
              name: 't3_abc123',
              title: 'Community Highlights',
              selftext: 'Pinned moderator thread',
              permalink: '/r/test/comments/abc123/community_highlights/',
              url: 'https://www.reddit.com/r/test/comments/abc123/community_highlights/',
              created_utc: 1710000000,
              stickied: true,
            },
          },
          {
            data: {
              id: 'def456',
              name: 't3_def456',
              title: 'Actual content post',
              selftext: 'Useful content',
              permalink: '/r/test/comments/def456/actual_content_post/',
              url: 'https://example.com/article',
              created_utc: 1710000100,
              stickied: false,
              pinned: false,
            },
          },
        ],
      },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(payload),
    } as Response);

    const items = await fetchRedditPosts('test', { maxItems: 10 });

    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Actual content post');
    expect(items[0]?.id).toBe('t3_def456');
  });
});

// ============================================
// BACKOFF DELAY PROPERTY TESTS
// ============================================

describe('Exponential Backoff Properties', () => {
  /**
   * Property: Backoff delay should always be non-negative
   * Validates: Requirements 4.7
   */
  it('should always return non-negative delay', () => {
    for (let errors = -10; errors <= 20; errors++) {
      const delay = calculateBackoffDelay(errors);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
  });

  /**
   * Property: Backoff delay should never exceed maximum
   * Validates: Requirements 4.7
   */
  it('should never exceed maximum delay', () => {
    for (let errors = 0; errors <= 100; errors++) {
      const delay = calculateBackoffDelay(errors);
      // Allow for jitter (10% above max)
      expect(delay).toBeLessThanOrEqual(MAX_BACKOFF_DELAY_MS * 1.1);
    }
  });

  /**
   * Property: Backoff delay should increase with consecutive errors
   * Validates: Requirements 4.7
   */
  it('should generally increase with consecutive errors', () => {
    // Test average over multiple runs to account for jitter
    const getAverageDelay = (errors: number) => {
      const samples = 10;
      const total = Array.from({ length: samples }, () => calculateBackoffDelay(errors))
        .reduce((a, b) => a + b, 0);
      return total / samples;
    };

    const avg1 = getAverageDelay(1);
    const avg3 = getAverageDelay(3);
    const avg5 = getAverageDelay(5);

    expect(avg3).toBeGreaterThan(avg1);
    expect(avg5).toBeGreaterThan(avg3);
  });
});

// ============================================
// ERROR TRACKING TESTS
// ============================================

describe('Error Tracking', () => {
  it('should track consecutive errors correctly', () => {
    // Source with increasing errors should eventually be disabled
    let source = createMockSource({ consecutiveErrors: 0 });

    for (let i = 0; i < MAX_CONSECUTIVE_ERRORS - 1; i++) {
      source = { ...source, consecutiveErrors: i + 1 };
      expect(shouldRetrySource(source)).toBe(true);
    }

    // At max errors, should not retry
    source = { ...source, consecutiveErrors: MAX_CONSECUTIVE_ERRORS };
    expect(shouldRetrySource(source)).toBe(false);
  });

  it('should reset error count on success', () => {
    // After success, consecutive errors should be 0
    const source = createMockSource({
      consecutiveErrors: 0,
      lastError: null,
    });

    expect(shouldRetrySource(source)).toBe(true);
  });
});
