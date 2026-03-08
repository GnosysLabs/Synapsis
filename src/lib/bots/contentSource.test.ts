/**
 * Unit Tests for Content Source Service
 * 
 * Tests URL validation, source type validation, and content source management.
 * 
 * Requirements: 4.1, 4.6
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  // Types
  ContentSourceType,
  ContentSourceConfig,
  SUPPORTED_SOURCE_TYPES,

  MAX_KEYWORDS,
  MAX_KEYWORD_LENGTH,
  // Validation functions
  isSupportedSourceType,
  isValidUrl,
  validateSourceUrl,
  validateSourceType,
  validateSubreddit,
  validateNewsApiKey,

  validateKeywords,
  validateContentSourceConfig,
  extractSubredditFromUrl,
  // Error classes
  ContentSourceError,
  ContentSourceNotFoundError,
  BotNotFoundError,
  ContentSourceValidationError,
} from './contentSource';

// ============================================
// SOURCE TYPE VALIDATION TESTS
// ============================================

describe('isSupportedSourceType', () => {
  it('should return true for supported source types', () => {
    expect(isSupportedSourceType('rss')).toBe(true);
    expect(isSupportedSourceType('reddit')).toBe(true);
    expect(isSupportedSourceType('news_api')).toBe(true);
  });

  it('should return false for unsupported source types', () => {
    expect(isSupportedSourceType('twitter')).toBe(false);
    expect(isSupportedSourceType('facebook')).toBe(false);
    expect(isSupportedSourceType('')).toBe(false);
    expect(isSupportedSourceType('RSS')).toBe(false); // Case sensitive
  });
});

describe('validateSourceType', () => {
  it('should return no errors for valid source types', () => {
    expect(validateSourceType('rss')).toEqual([]);
    expect(validateSourceType('reddit')).toEqual([]);
    expect(validateSourceType('news_api')).toEqual([]);
  });

  it('should return error for missing source type', () => {
    expect(validateSourceType(undefined)).toContain('Source type is required');
    expect(validateSourceType(null)).toContain('Source type is required');
    expect(validateSourceType('')).toContain('Source type is required');
  });

  it('should return error for unsupported source type', () => {
    const errors = validateSourceType('twitter');
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('Unsupported source type');
    expect(errors[0]).toContain('twitter');
  });

  it('should return error for non-string source type', () => {
    expect(validateSourceType(123)).toContain('Source type is required');
    expect(validateSourceType({})).toContain('Source type is required');
  });
});

// ============================================
// URL VALIDATION TESTS
// ============================================

describe('isValidUrl', () => {
  it('should return true for valid HTTP URLs', () => {
    expect(isValidUrl('http://example.com')).toBe(true);
    expect(isValidUrl('http://example.com/path')).toBe(true);
    expect(isValidUrl('http://example.com/path?query=1')).toBe(true);
  });

  it('should return true for valid HTTPS URLs', () => {
    expect(isValidUrl('https://example.com')).toBe(true);
    expect(isValidUrl('https://example.com/path')).toBe(true);
    expect(isValidUrl('https://subdomain.example.com')).toBe(true);
  });

  it('should return false for invalid URLs', () => {
    expect(isValidUrl('')).toBe(false);
    expect(isValidUrl('not-a-url')).toBe(false);
    expect(isValidUrl('ftp://example.com')).toBe(false);
    expect(isValidUrl('file:///path')).toBe(false);
  });

  it('should return false for non-string inputs', () => {
    expect(isValidUrl(null as unknown as string)).toBe(false);
    expect(isValidUrl(undefined as unknown as string)).toBe(false);
    expect(isValidUrl(123 as unknown as string)).toBe(false);
  });
});

describe('validateSourceUrl', () => {
  describe('RSS URLs', () => {
    it('should accept valid RSS feed URLs', () => {
      expect(validateSourceUrl('https://example.com/feed.xml', 'rss')).toEqual([]);
      expect(validateSourceUrl('https://blog.example.com/rss', 'rss')).toEqual([]);
      expect(validateSourceUrl('http://example.com/feed', 'rss')).toEqual([]);
    });

    it('should reject invalid RSS URLs', () => {
      const errors = validateSourceUrl('not-a-url', 'rss');
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('Reddit URLs', () => {
    it('should accept valid Reddit subreddit URLs', () => {
      expect(validateSourceUrl('https://reddit.com/r/programming', 'reddit')).toEqual([]);
      expect(validateSourceUrl('https://www.reddit.com/r/javascript', 'reddit')).toEqual([]);
      expect(validateSourceUrl('https://old.reddit.com/r/typescript', 'reddit')).toEqual([]);
    });

    it('should reject invalid Reddit URLs', () => {
      const errors1 = validateSourceUrl('https://reddit.com', 'reddit');
      expect(errors1.length).toBeGreaterThan(0);
      expect(errors1[0]).toContain('subreddit URL');

      const errors2 = validateSourceUrl('https://example.com/r/test', 'reddit');
      expect(errors2.length).toBeGreaterThan(0);
    });
  });

  describe('News API URLs', () => {
    it('should accept valid news API URLs', () => {
      expect(validateSourceUrl('https://newsapi.org/v2/everything', 'news_api')).toEqual([]);
      expect(validateSourceUrl('https://api.example.com/news', 'news_api')).toEqual([]);
      expect(validateSourceUrl('https://gnews.io/api/v4/search', 'news_api')).toEqual([]);
    });

    it('should reject invalid news API URLs', () => {
      const errors = validateSourceUrl('https://example.com/page', 'news_api');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('API endpoint');
    });
  });

  describe('Common URL validation', () => {
    it('should reject empty URLs', () => {
      expect(validateSourceUrl('', 'rss')).toContain('URL is required');
      expect(validateSourceUrl('   ', 'rss')).toContain('URL cannot be empty');
    });

    it('should reject URLs that are too long', () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(2050);
      const errors = validateSourceUrl(longUrl, 'rss');
      expect(errors.some(e => e.includes('too long'))).toBe(true);
    });

    it('should reject non-HTTP/HTTPS URLs', () => {
      const errors = validateSourceUrl('ftp://example.com/feed', 'rss');
      expect(errors.some(e => e.includes('HTTP or HTTPS'))).toBe(true);
    });
  });
});

// ============================================
// SUBREDDIT VALIDATION TESTS
// ============================================

describe('validateSubreddit', () => {
  it('should return no errors for valid subreddit names', () => {
    expect(validateSubreddit('programming', 'reddit')).toEqual([]);
    expect(validateSubreddit('javascript', 'reddit')).toEqual([]);
    expect(validateSubreddit('test_subreddit', 'reddit')).toEqual([]);
    expect(validateSubreddit('abc', 'reddit')).toEqual([]); // Minimum 3 chars
  });

  it('should skip validation for non-Reddit sources', () => {
    expect(validateSubreddit(undefined, 'rss')).toEqual([]);
    expect(validateSubreddit(undefined, 'news_api')).toEqual([]);
  });

  it('should require subreddit for Reddit sources', () => {
    expect(validateSubreddit(undefined, 'reddit')).toContain('Subreddit name is required for Reddit sources');
    expect(validateSubreddit(null, 'reddit')).toContain('Subreddit name is required for Reddit sources');
    expect(validateSubreddit('', 'reddit')).toContain('Subreddit name is required for Reddit sources');
  });

  it('should reject invalid subreddit names', () => {
    // Too short
    expect(validateSubreddit('ab', 'reddit').length).toBeGreaterThan(0);

    // Too long (max 21 chars)
    expect(validateSubreddit('a'.repeat(22), 'reddit').length).toBeGreaterThan(0);

    // Invalid characters
    expect(validateSubreddit('test-subreddit', 'reddit').length).toBeGreaterThan(0);
    expect(validateSubreddit('test subreddit', 'reddit').length).toBeGreaterThan(0);
  });
});

// ============================================
// NEWS API KEY VALIDATION TESTS
// ============================================

describe('validateNewsApiKey', () => {
  it('should return no errors for valid API keys', () => {
    expect(validateNewsApiKey('abcdefghij1234567890', 'news_api')).toEqual([]);
    expect(validateNewsApiKey('a'.repeat(50), 'news_api')).toEqual([]);
  });

  it('should skip validation for non-news_api sources', () => {
    expect(validateNewsApiKey(undefined, 'rss')).toEqual([]);
    expect(validateNewsApiKey(undefined, 'reddit')).toEqual([]);
  });

  it('should require API key for news_api sources', () => {
    expect(validateNewsApiKey(undefined, 'news_api')).toContain('API key is required for news API sources');
    expect(validateNewsApiKey(null, 'news_api')).toContain('API key is required for news API sources');
    expect(validateNewsApiKey('', 'news_api')).toContain('API key is required for news API sources');
  });

  it('should reject API keys that are too short', () => {
    expect(validateNewsApiKey('short', 'news_api').some(e => e.includes('too short'))).toBe(true);
  });

  it('should reject API keys that are too long', () => {
    expect(validateNewsApiKey('a'.repeat(300), 'news_api').some(e => e.includes('too long'))).toBe(true);
  });
});



// ============================================
// KEYWORDS VALIDATION TESTS
// ============================================

describe('validateKeywords', () => {
  it('should return no errors for valid keywords', () => {
    expect(validateKeywords(['javascript', 'typescript'])).toEqual([]);
    expect(validateKeywords(['single'])).toEqual([]);
    expect(validateKeywords([])).toEqual([]);
  });

  it('should allow undefined/null (optional field)', () => {
    expect(validateKeywords(undefined)).toEqual([]);
    expect(validateKeywords(null)).toEqual([]);
  });

  it('should reject non-array values', () => {
    expect(validateKeywords('keyword')).toContain('Keywords must be an array');
    expect(validateKeywords({})).toContain('Keywords must be an array');
  });

  it('should reject too many keywords', () => {
    const tooManyKeywords = Array(MAX_KEYWORDS + 1).fill('keyword');
    expect(validateKeywords(tooManyKeywords).some(e => e.includes('Maximum'))).toBe(true);
  });

  it('should reject non-string keywords', () => {
    expect(validateKeywords([123]).some(e => e.includes('must be a string'))).toBe(true);
    expect(validateKeywords([null]).some(e => e.includes('must be a string'))).toBe(true);
  });

  it('should reject empty keywords', () => {
    expect(validateKeywords(['']).some(e => e.includes('cannot be empty'))).toBe(true);
    expect(validateKeywords(['   ']).some(e => e.includes('cannot be empty'))).toBe(true);
  });

  it('should reject keywords that are too long', () => {
    const longKeyword = 'a'.repeat(MAX_KEYWORD_LENGTH + 1);
    expect(validateKeywords([longKeyword]).some(e => e.includes('too long'))).toBe(true);
  });
});

// ============================================
// COMPLETE CONFIG VALIDATION TESTS
// ============================================

describe('validateContentSourceConfig', () => {
  it('should validate a complete RSS config', () => {
    const config: ContentSourceConfig = {
      type: 'rss',
      url: 'https://example.com/feed.xml',

      keywords: ['tech', 'news'],
    };

    const result = validateContentSourceConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('should validate a complete Reddit config', () => {
    const config: ContentSourceConfig = {
      type: 'reddit',
      url: 'https://reddit.com/r/programming',
      subreddit: 'programming',

    };

    const result = validateContentSourceConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('should validate a complete news_api config', () => {
    const config: ContentSourceConfig = {
      type: 'news_api',
      url: 'https://newsapi.org/v2/everything',
      apiKey: 'abcdefghij1234567890',

      keywords: ['technology'],
    };

    const result = validateContentSourceConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('should reject non-object configs', () => {
    expect(validateContentSourceConfig(null).valid).toBe(false);
    expect(validateContentSourceConfig(undefined).valid).toBe(false);
    expect(validateContentSourceConfig('string').valid).toBe(false);
  });

  it('should collect all validation errors', () => {
    const config = {
      type: 'reddit',
      url: 'not-a-url',
      // Missing subreddit
    };

    const result = validateContentSourceConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });

  it('should use default fetch interval when not provided', () => {
    const config: ContentSourceConfig = {
      type: 'rss',
      url: 'https://example.com/feed.xml',
    };

    const result = validateContentSourceConfig(config);
    expect(result.valid).toBe(true);
  });
});

// ============================================
// HELPER FUNCTION TESTS
// ============================================

describe('extractSubredditFromUrl', () => {
  it('should extract subreddit from standard Reddit URLs', () => {
    expect(extractSubredditFromUrl('https://reddit.com/r/programming')).toBe('programming');
    expect(extractSubredditFromUrl('https://www.reddit.com/r/javascript')).toBe('javascript');
    expect(extractSubredditFromUrl('https://old.reddit.com/r/typescript')).toBe('typescript');
  });

  it('should extract subreddit from URLs with paths', () => {
    expect(extractSubredditFromUrl('https://reddit.com/r/programming/hot')).toBe('programming');
    expect(extractSubredditFromUrl('https://reddit.com/r/test/comments/123')).toBe('test');
  });

  it('should return null for non-Reddit URLs', () => {
    expect(extractSubredditFromUrl('https://example.com')).toBe(null);
    expect(extractSubredditFromUrl('https://example.com/r/test')).toBe(null);
  });

  it('should return null for Reddit URLs without subreddit', () => {
    expect(extractSubredditFromUrl('https://reddit.com')).toBe(null);
    expect(extractSubredditFromUrl('https://reddit.com/user/test')).toBe(null);
  });
});

// ============================================
// ERROR CLASS TESTS
// ============================================

describe('Error Classes', () => {
  describe('ContentSourceError', () => {
    it('should create error with message and code', () => {
      const error = new ContentSourceError('Test error', 'TEST_CODE');
      expect(error.message).toBe('Test error');
      expect(error.code).toBe('TEST_CODE');
      expect(error.name).toBe('ContentSourceError');
    });
  });

  describe('ContentSourceNotFoundError', () => {
    it('should create error with source ID', () => {
      const error = new ContentSourceNotFoundError('source-123');
      expect(error.message).toContain('source-123');
      expect(error.code).toBe('SOURCE_NOT_FOUND');
    });
  });

  describe('BotNotFoundError', () => {
    it('should create error with bot ID', () => {
      const error = new BotNotFoundError('bot-123');
      expect(error.message).toContain('bot-123');
      expect(error.code).toBe('BOT_NOT_FOUND');
    });
  });

  describe('ContentSourceValidationError', () => {
    it('should create error with message and errors array', () => {
      const error = new ContentSourceValidationError('Validation failed', ['Error 1', 'Error 2']);
      expect(error.message).toBe('Validation failed');
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.errors).toEqual(['Error 1', 'Error 2']);
    });
  });
});

// ============================================
// CONSTANTS TESTS
// ============================================

describe('Constants', () => {
  it('should have correct supported source types', () => {
    expect(SUPPORTED_SOURCE_TYPES).toContain('rss');
    expect(SUPPORTED_SOURCE_TYPES).toContain('reddit');
    expect(SUPPORTED_SOURCE_TYPES).toContain('news_api');
    expect(SUPPORTED_SOURCE_TYPES).toContain('brave_news');
    expect(SUPPORTED_SOURCE_TYPES).toContain('youtube');
    expect(SUPPORTED_SOURCE_TYPES.length).toBe(5);
  });



  it('should have reasonable keyword limits', () => {
    expect(MAX_KEYWORDS).toBeGreaterThan(0);
    expect(MAX_KEYWORD_LENGTH).toBeGreaterThan(0);
  });
});
