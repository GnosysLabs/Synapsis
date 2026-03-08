/**
 * Property-Based Tests for Content Source URL Validation
 * 
 * Feature: bot-system, Property 11: Content Source URL Validation
 * 
 * Tests the content source URL and type validation using fast-check
 * for property-based testing.
 * 
 * **Validates: Requirements 4.1**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  validateSourceUrl,
  validateSourceType,
  validateContentSourceConfig,
  isSupportedSourceType,
  isValidUrl,
  ContentSourceType,
  SUPPORTED_SOURCE_TYPES,
  ContentSourceValidationResult,
} from './contentSource';

// ============================================
// GENERATORS
// ============================================

/**
 * Generator for invalid URLs - strings that should NOT pass URL validation.
 * 
 * Invalid URLs include:
 * - Empty strings
 * - Strings without protocol
 * - Strings with invalid protocols (ftp, file, etc.)
 * - Malformed URLs
 * - Strings with spaces
 * - Random garbage strings
 */

// Generator for empty or whitespace-only strings
const emptyOrWhitespaceArb = fc.oneof(
  fc.constant(''),
  fc.constant('   '),
  fc.constant('\t\n'),
  fc.constant('  \t  '),
  fc.constant('\n\r\t'),
  fc.constant('     ')
);

// Generator for URLs without protocol
const noProtocolUrlArb = fc.oneof(
  fc.constant('example.com'),
  fc.constant('www.example.com/path'),
  fc.constant('reddit.com/r/test'),
  fc.stringMatching(/^[a-z0-9]+\.[a-z]{2,4}(\/[a-z0-9]+)?$/)
);

// Generator for URLs with invalid protocols
const invalidProtocolUrlArb = fc.oneof(
  fc.constant('ftp://example.com'),
  fc.constant('file:///path/to/file'),
  fc.constant('mailto:test@example.com'),
  fc.constant('javascript:alert(1)'),
  fc.constant('data:text/html,<h1>test</h1>'),
  fc.stringMatching(/^[a-z]{2,10}:\/\/[a-z0-9]+\.[a-z]{2,4}$/)
    .filter(s => !s.startsWith('http://') && !s.startsWith('https://'))
);

// Generator for malformed URLs (invalid characters, structure)
// Note: Only include URLs that will actually fail URL parsing
const malformedUrlArb = fc.oneof(
  fc.constant('http://'),
  fc.constant('https://'),
  fc.constant('http://example .com'),  // Space in hostname
  fc.constant('http://exam ple.com/path'),  // Space in hostname
  fc.constant('http://[invalid'),  // Invalid IPv6
  fc.constant('http://example.com:abc'),  // Invalid port
  fc.constant('http://user:pass@'),  // Missing host after auth
  fc.constant('://example.com'),  // Missing protocol
);

// Generator for URLs that are too long (> 2048 characters)
const tooLongUrlArb = fc.stringMatching(/^[a-z0-9]{2100,2500}$/)
  .map(s => `https://example.com/${s}`);

// Generator for random garbage strings (most will be invalid URLs)
const randomGarbageArb = fc.string({ minLength: 1, maxLength: 100 })
  .filter(s => {
    try {
      new URL(s);
      return false; // Filter out accidentally valid URLs
    } catch {
      return true;
    }
  });

// Combined generator for all invalid URLs
const invalidUrlArb = fc.oneof(
  emptyOrWhitespaceArb,
  noProtocolUrlArb,
  invalidProtocolUrlArb,
  malformedUrlArb,
  randomGarbageArb
);

/**
 * Generator for unsupported source types.
 * 
 * Unsupported types include:
 * - Empty strings
 * - Random strings that aren't 'rss', 'reddit', or 'news_api'
 * - Typos of valid types
 * - Non-string values
 */

// Generator for unsupported type strings
const unsupportedTypeStringArb = fc.string({ minLength: 1, maxLength: 50 })
  .filter(s => !SUPPORTED_SOURCE_TYPES.includes(s as ContentSourceType));

// Generator for typos of valid types
const typoTypeArb = fc.oneof(
  fc.constant('RSS'),
  fc.constant('Rss'),
  fc.constant('rss '),
  fc.constant(' rss'),
  fc.constant('reddit '),
  fc.constant('Reddit'),
  fc.constant('REDDIT'),
  fc.constant('news_API'),
  fc.constant('newsapi'),
  fc.constant('news-api'),
  fc.constant('atom'),
  fc.constant('twitter'),
  fc.constant('facebook'),
  fc.constant('api'),
  fc.constant('feed'),
);

// Combined generator for unsupported types
const unsupportedTypeArb = fc.oneof(
  unsupportedTypeStringArb,
  typoTypeArb,
  fc.constant(''),
);

/**
 * Generator for valid URLs (for testing type-specific validation).
 */
const validHttpUrlArb = fc.oneof(
  fc.constant('https://example.com'),
  fc.constant('https://example.com/feed.xml'),
  fc.constant('http://test.org/rss'),
  fc.stringMatching(/^[a-z0-9]{3,20}$/).map(s => `https://${s}.com/feed`)
);

/**
 * Generator for invalid Reddit URLs (valid HTTP URLs but not Reddit format).
 */
const invalidRedditUrlArb = fc.oneof(
  fc.constant('https://example.com'),
  fc.constant('https://twitter.com/user'),
  fc.constant('https://reddit.com'), // Missing /r/subreddit
  fc.constant('https://reddit.com/user/test'),
  fc.constant('https://reddit.com/r/'), // Missing subreddit name
  fc.constant('https://notreddit.com/r/test'),
  validHttpUrlArb.filter(url => !url.includes('reddit.com/r/'))
);

/**
 * Generator for invalid News API URLs (valid HTTP URLs but not API format).
 */
const invalidNewsApiUrlArb = fc.oneof(
  fc.constant('https://example.com'),
  fc.constant('https://news.google.com'),
  fc.constant('https://cnn.com/news'),
  fc.constant('http://bbc.com/feed'),
  validHttpUrlArb.filter(url => 
    !url.includes('newsapi.org') && 
    !url.includes('gnews.io') && 
    !url.includes('newsdata.io') &&
    !url.includes('api.')
  )
);

/**
 * Generator for valid RSS URLs.
 */
const validRssUrlArb = fc.oneof(
  fc.constant('https://example.com/feed.xml'),
  fc.constant('https://blog.example.org/rss'),
  fc.constant('http://news.site.com/feed'),
  fc.stringMatching(/^[a-z0-9]{3,15}$/).map(s => `https://${s}.com/feed.xml`)
);

/**
 * Generator for valid Reddit URLs.
 */
const validRedditUrlArb = fc.oneof(
  fc.constant('https://reddit.com/r/programming'),
  fc.constant('https://www.reddit.com/r/technology'),
  fc.constant('https://old.reddit.com/r/news'),
  fc.stringMatching(/^[a-zA-Z0-9_]{3,21}$/).map(s => `https://reddit.com/r/${s}`)
);

/**
 * Generator for valid News API URLs.
 */
const validNewsApiUrlArb = fc.oneof(
  fc.constant('https://newsapi.org/v2/everything'),
  fc.constant('https://gnews.io/api/v4/search'),
  fc.constant('https://api.newsdata.io/v1/news'),
  fc.constant('https://api.example.com/news'),
);

/**
 * Generator for supported source types.
 */
const supportedTypeArb = fc.constantFrom<ContentSourceType>('rss', 'reddit', 'news_api');

// ============================================
// PROPERTY TESTS
// ============================================

describe('Feature: bot-system, Property 11: Content Source URL Validation', () => {
  /**
   * Property 11: Content Source URL Validation
   * 
   * *For any* invalid URL or unsupported source type, adding a content source 
   * SHALL fail with a validation error.
   * 
   * **Validates: Requirements 4.1**
   */

  describe('Invalid URLs are rejected', () => {
    it('rejects empty or whitespace-only URLs for all source types', () => {
      fc.assert(
        fc.property(emptyOrWhitespaceArb, supportedTypeArb, (url, type) => {
          const errors = validateSourceUrl(url, type);
          expect(errors.length).toBeGreaterThan(0);
          expect(errors.some(e => 
            e.includes('required') || 
            e.includes('empty') || 
            e.includes('valid')
          )).toBe(true);
        }),
        { numRuns: 100 }
      );
    });

    it('rejects URLs without HTTP/HTTPS protocol for all source types', () => {
      fc.assert(
        fc.property(noProtocolUrlArb, supportedTypeArb, (url, type) => {
          const errors = validateSourceUrl(url, type);
          expect(errors.length).toBeGreaterThan(0);
        }),
        { numRuns: 100 }
      );
    });

    it('rejects URLs with invalid protocols for all source types', () => {
      fc.assert(
        fc.property(invalidProtocolUrlArb, supportedTypeArb, (url, type) => {
          const errors = validateSourceUrl(url, type);
          expect(errors.length).toBeGreaterThan(0);
        }),
        { numRuns: 100 }
      );
    });

    it('rejects malformed URLs for all source types', () => {
      fc.assert(
        fc.property(malformedUrlArb, supportedTypeArb, (url, type) => {
          const errors = validateSourceUrl(url, type);
          expect(errors.length).toBeGreaterThan(0);
        }),
        { numRuns: 100 }
      );
    });

    it('rejects URLs that are too long (> 2048 characters)', () => {
      fc.assert(
        fc.property(tooLongUrlArb, supportedTypeArb, (url, type) => {
          const errors = validateSourceUrl(url, type);
          expect(errors.length).toBeGreaterThan(0);
          expect(errors.some(e => e.includes('too long'))).toBe(true);
        }),
        { numRuns: 100 }
      );
    });

    it('rejects random garbage strings as URLs', () => {
      fc.assert(
        fc.property(randomGarbageArb, supportedTypeArb, (url, type) => {
          const errors = validateSourceUrl(url, type);
          expect(errors.length).toBeGreaterThan(0);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Unsupported source types are rejected', () => {
    it('rejects unsupported source type strings', () => {
      fc.assert(
        fc.property(unsupportedTypeStringArb, (type) => {
          const errors = validateSourceType(type);
          expect(errors.length).toBeGreaterThan(0);
          expect(errors.some(e => e.includes('Unsupported source type'))).toBe(true);
        }),
        { numRuns: 100 }
      );
    });

    it('rejects typos of valid source types', () => {
      fc.assert(
        fc.property(typoTypeArb, (type) => {
          const errors = validateSourceType(type);
          expect(errors.length).toBeGreaterThan(0);
        }),
        { numRuns: 100 }
      );
    });

    it('rejects empty string as source type', () => {
      const errors = validateSourceType('');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.includes('required'))).toBe(true);
    });

    it('rejects null and undefined as source type', () => {
      const nullErrors = validateSourceType(null);
      const undefinedErrors = validateSourceType(undefined);
      
      expect(nullErrors.length).toBeGreaterThan(0);
      expect(undefinedErrors.length).toBeGreaterThan(0);
    });

    it('rejects non-string values as source type', () => {
      const invalidTypes = [123, {}, [], true, false];
      
      for (const invalidType of invalidTypes) {
        const errors = validateSourceType(invalidType);
        expect(errors.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Type-specific URL validation', () => {
    it('rejects non-Reddit URLs for Reddit source type', () => {
      fc.assert(
        fc.property(invalidRedditUrlArb, (url) => {
          const errors = validateSourceUrl(url, 'reddit');
          expect(errors.length).toBeGreaterThan(0);
          expect(errors.some(e => e.includes('Reddit') || e.includes('subreddit'))).toBe(true);
        }),
        { numRuns: 100 }
      );
    });

    it('rejects non-API URLs for news_api source type', () => {
      fc.assert(
        fc.property(invalidNewsApiUrlArb, (url) => {
          const errors = validateSourceUrl(url, 'news_api');
          expect(errors.length).toBeGreaterThan(0);
          expect(errors.some(e => e.includes('API') || e.includes('endpoint'))).toBe(true);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Complete configuration validation', () => {
    it('rejects configurations with invalid URL and valid type', () => {
      fc.assert(
        fc.property(invalidUrlArb, supportedTypeArb, (url, type) => {
          const config = { url, type };
          const result: ContentSourceValidationResult = validateContentSourceConfig(config);
          
          expect(result.valid).toBe(false);
          expect(result.errors.length).toBeGreaterThan(0);
        }),
        { numRuns: 100 }
      );
    });

    it('rejects configurations with valid URL and invalid type', () => {
      fc.assert(
        fc.property(validHttpUrlArb, unsupportedTypeArb, (url, type) => {
          const config = { url, type };
          const result: ContentSourceValidationResult = validateContentSourceConfig(config);
          
          expect(result.valid).toBe(false);
          expect(result.errors.length).toBeGreaterThan(0);
        }),
        { numRuns: 100 }
      );
    });

    it('rejects configurations with both invalid URL and invalid type', () => {
      fc.assert(
        fc.property(invalidUrlArb, unsupportedTypeArb, (url, type) => {
          const config = { url, type };
          const result: ContentSourceValidationResult = validateContentSourceConfig(config);
          
          expect(result.valid).toBe(false);
          expect(result.errors.length).toBeGreaterThan(0);
        }),
        { numRuns: 100 }
      );
    });

    it('rejects non-object configurations', () => {
      const invalidConfigs = [null, undefined, 'string', 123, [], true];
      
      for (const config of invalidConfigs) {
        const result: ContentSourceValidationResult = validateContentSourceConfig(config);
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
      }
    });

    it('rejects configurations missing required fields', () => {
      const incompleteConfigs = [
        {},
        { url: 'https://example.com' }, // Missing type
        { type: 'rss' }, // Missing url
      ];
      
      for (const config of incompleteConfigs) {
        const result: ContentSourceValidationResult = validateContentSourceConfig(config);
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Valid configurations are accepted', () => {
    it('accepts valid RSS configurations', () => {
      fc.assert(
        fc.property(validRssUrlArb, (url) => {
          const config = { url, type: 'rss' as const };
          const result: ContentSourceValidationResult = validateContentSourceConfig(config);
          
          expect(result.valid).toBe(true);
          expect(result.errors.length).toBe(0);
        }),
        { numRuns: 100 }
      );
    });

    it('accepts valid Reddit configurations with subreddit', () => {
      fc.assert(
        fc.property(
          validRedditUrlArb,
          fc.stringMatching(/^[a-zA-Z0-9_]{3,21}$/),
          (url, subreddit) => {
            const config = { url, type: 'reddit' as const, subreddit };
            const result: ContentSourceValidationResult = validateContentSourceConfig(config);
            
            expect(result.valid).toBe(true);
            expect(result.errors.length).toBe(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('accepts valid News API configurations with API key', () => {
      fc.assert(
        fc.property(
          validNewsApiUrlArb,
          fc.stringMatching(/^[a-zA-Z0-9]{10,100}$/),
          (url, apiKey) => {
            const config = { url, type: 'news_api' as const, apiKey };
            const result: ContentSourceValidationResult = validateContentSourceConfig(config);
            
            expect(result.valid).toBe(true);
            expect(result.errors.length).toBe(0);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Helper function validation', () => {
    it('isSupportedSourceType returns false for unsupported types', () => {
      fc.assert(
        fc.property(unsupportedTypeStringArb, (type) => {
          expect(isSupportedSourceType(type)).toBe(false);
        }),
        { numRuns: 100 }
      );
    });

    it('isSupportedSourceType returns true for supported types', () => {
      for (const type of SUPPORTED_SOURCE_TYPES) {
        expect(isSupportedSourceType(type)).toBe(true);
      }
    });

    it('isValidUrl returns false for invalid URLs', () => {
      fc.assert(
        fc.property(invalidUrlArb, (url) => {
          expect(isValidUrl(url)).toBe(false);
        }),
        { numRuns: 100 }
      );
    });

    it('isValidUrl returns true for valid HTTP/HTTPS URLs', () => {
      fc.assert(
        fc.property(validHttpUrlArb, (url) => {
          expect(isValidUrl(url)).toBe(true);
        }),
        { numRuns: 100 }
      );
    });

    it('isValidUrl returns false for non-string inputs', () => {
      const invalidInputs = [null, undefined, 123, {}, [], true];
      
      for (const input of invalidInputs) {
        expect(isValidUrl(input as unknown as string)).toBe(false);
      }
    });
  });
});

// ============================================
// PROPERTY 14: MULTIPLE SOURCE TYPES PER BOT
// ============================================

/**
 * Property-Based Tests for Multiple Source Types Per Bot
 * 
 * Feature: bot-system, Property 14: Multiple Source Types Per Bot
 * 
 * Tests that bots can have content sources of different types (RSS, Reddit, news API)
 * and all succeed and are retrievable.
 * 
 * **Validates: Requirements 4.6**
 */

describe('Feature: bot-system, Property 14: Multiple Source Types Per Bot', () => {
  /**
   * Property 14: Multiple Source Types Per Bot
   * 
   * *For any* bot, adding content sources of different types (RSS, Reddit, news API) 
   * SHALL all succeed and be retrievable.
   * 
   * **Validates: Requirements 4.6**
   */

  // ============================================
  // GENERATORS FOR PROPERTY 14
  // ============================================

  /**
   * Generator for valid RSS source configurations.
   */
  const validRssConfigArb = fc.record({
    type: fc.constant('rss' as const),
    url: fc.oneof(
      fc.constant('https://example.com/feed.xml'),
      fc.constant('https://blog.example.org/rss'),
      fc.constant('http://news.site.com/feed'),
      fc.stringMatching(/^[a-z0-9]{3,15}$/).map(s => `https://${s}.com/feed.xml`)
    ),
    fetchInterval: fc.option(fc.integer({ min: 5, max: 1440 }), { nil: undefined }),
    keywords: fc.option(
      fc.array(fc.stringMatching(/^[a-zA-Z0-9]{1,50}$/), { minLength: 0, maxLength: 5 }),
      { nil: undefined }
    ),
  });

  /**
   * Generator for valid Reddit source configurations.
   */
  const validRedditConfigArb = fc.record({
    type: fc.constant('reddit' as const),
    url: fc.oneof(
      fc.constant('https://reddit.com/r/programming'),
      fc.constant('https://www.reddit.com/r/technology'),
      fc.constant('https://old.reddit.com/r/news'),
      fc.stringMatching(/^[a-zA-Z0-9_]{3,21}$/).map(s => `https://reddit.com/r/${s}`)
    ),
    subreddit: fc.stringMatching(/^[a-zA-Z0-9_]{3,21}$/),
    fetchInterval: fc.option(fc.integer({ min: 5, max: 1440 }), { nil: undefined }),
    keywords: fc.option(
      fc.array(fc.stringMatching(/^[a-zA-Z0-9]{1,50}$/), { minLength: 0, maxLength: 5 }),
      { nil: undefined }
    ),
  });

  /**
   * Generator for valid News API source configurations.
   */
  const validNewsApiConfigArb = fc.record({
    type: fc.constant('news_api' as const),
    url: fc.oneof(
      fc.constant('https://newsapi.org/v2/everything'),
      fc.constant('https://gnews.io/api/v4/search'),
      fc.constant('https://api.newsdata.io/v1/news'),
      fc.constant('https://api.example.com/news')
    ),
    apiKey: fc.stringMatching(/^[a-zA-Z0-9]{10,100}$/),
    fetchInterval: fc.option(fc.integer({ min: 5, max: 1440 }), { nil: undefined }),
    keywords: fc.option(
      fc.array(fc.stringMatching(/^[a-zA-Z0-9]{1,50}$/), { minLength: 0, maxLength: 5 }),
      { nil: undefined }
    ),
  });

  /**
   * Generator for a combination of all three source types.
   */
  const allSourceTypesConfigArb = fc.tuple(
    validRssConfigArb,
    validRedditConfigArb,
    validNewsApiConfigArb
  );

  /**
   * Generator for a non-empty subset of source types.
   */
  const sourceTypeSubsetArb = fc.oneof(
    // Single types
    fc.tuple(validRssConfigArb).map(configs => configs),
    fc.tuple(validRedditConfigArb).map(configs => configs),
    fc.tuple(validNewsApiConfigArb).map(configs => configs),
    // Pairs
    fc.tuple(validRssConfigArb, validRedditConfigArb).map(configs => configs),
    fc.tuple(validRssConfigArb, validNewsApiConfigArb).map(configs => configs),
    fc.tuple(validRedditConfigArb, validNewsApiConfigArb).map(configs => configs),
    // All three
    allSourceTypesConfigArb.map(configs => configs)
  );

  // ============================================
  // PROPERTY TESTS
  // ============================================

  describe('All source types validate successfully', () => {
    it('RSS configurations with valid URLs pass validation', () => {
      fc.assert(
        fc.property(validRssConfigArb, (config) => {
          const result: ContentSourceValidationResult = validateContentSourceConfig(config);
          
          expect(result.valid).toBe(true);
          expect(result.errors.length).toBe(0);
        }),
        { numRuns: 100 }
      );
    });

    it('Reddit configurations with valid URLs and subreddits pass validation', () => {
      fc.assert(
        fc.property(validRedditConfigArb, (config) => {
          const result: ContentSourceValidationResult = validateContentSourceConfig(config);
          
          expect(result.valid).toBe(true);
          expect(result.errors.length).toBe(0);
        }),
        { numRuns: 100 }
      );
    });

    it('News API configurations with valid URLs and API keys pass validation', () => {
      fc.assert(
        fc.property(validNewsApiConfigArb, (config) => {
          const result: ContentSourceValidationResult = validateContentSourceConfig(config);
          
          expect(result.valid).toBe(true);
          expect(result.errors.length).toBe(0);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Multiple source types can coexist', () => {
    it('all three source types (RSS, Reddit, news_api) can be validated independently', () => {
      fc.assert(
        fc.property(allSourceTypesConfigArb, ([rssConfig, redditConfig, newsApiConfig]) => {
          // Validate each source type independently
          const rssResult: ContentSourceValidationResult = validateContentSourceConfig(rssConfig);
          const redditResult: ContentSourceValidationResult = validateContentSourceConfig(redditConfig);
          const newsApiResult: ContentSourceValidationResult = validateContentSourceConfig(newsApiConfig);
          
          // All should pass validation
          expect(rssResult.valid).toBe(true);
          expect(redditResult.valid).toBe(true);
          expect(newsApiResult.valid).toBe(true);
          
          // All should have no errors
          expect(rssResult.errors.length).toBe(0);
          expect(redditResult.errors.length).toBe(0);
          expect(newsApiResult.errors.length).toBe(0);
          
          // Each should have the correct type
          expect(rssConfig.type).toBe('rss');
          expect(redditConfig.type).toBe('reddit');
          expect(newsApiConfig.type).toBe('news_api');
        }),
        { numRuns: 100 }
      );
    });

    it('any subset of source types can be validated together', () => {
      fc.assert(
        fc.property(sourceTypeSubsetArb, (configs) => {
          // Validate all configs in the subset
          const results = configs.map(config => ({
            config,
            result: validateContentSourceConfig(config) as ContentSourceValidationResult,
          }));
          
          // All should pass validation
          for (const { config, result } of results) {
            expect(result.valid).toBe(true);
            expect(result.errors.length).toBe(0);
            expect(SUPPORTED_SOURCE_TYPES).toContain(config.type);
          }
          
          // Verify we have at least one config
          expect(configs.length).toBeGreaterThan(0);
          expect(configs.length).toBeLessThanOrEqual(3);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Source type identification', () => {
    it('each source type is correctly identified as supported', () => {
      fc.assert(
        fc.property(allSourceTypesConfigArb, ([rssConfig, redditConfig, newsApiConfig]) => {
          // All types should be recognized as supported
          expect(isSupportedSourceType(rssConfig.type)).toBe(true);
          expect(isSupportedSourceType(redditConfig.type)).toBe(true);
          expect(isSupportedSourceType(newsApiConfig.type)).toBe(true);
          
          // Types should be distinct
          const types = new Set([rssConfig.type, redditConfig.type, newsApiConfig.type]);
          expect(types.size).toBe(3);
        }),
        { numRuns: 100 }
      );
    });

    it('SUPPORTED_SOURCE_TYPES contains the core and extended source types', () => {
      expect(SUPPORTED_SOURCE_TYPES).toContain('rss');
      expect(SUPPORTED_SOURCE_TYPES).toContain('reddit');
      expect(SUPPORTED_SOURCE_TYPES).toContain('news_api');
      expect(SUPPORTED_SOURCE_TYPES).toContain('brave_news');
      expect(SUPPORTED_SOURCE_TYPES).toContain('youtube');
      expect(SUPPORTED_SOURCE_TYPES.length).toBe(5);
    });
  });

  describe('Source type-specific validation', () => {
    it('RSS sources do not require subreddit or apiKey', () => {
      fc.assert(
        fc.property(validRssConfigArb, (config) => {
          // RSS config should not have subreddit or apiKey
          const configWithoutOptionals = {
            type: config.type,
            url: config.url,
          };
          
          const result: ContentSourceValidationResult = validateContentSourceConfig(configWithoutOptionals);
          
          expect(result.valid).toBe(true);
          expect(result.errors.length).toBe(0);
        }),
        { numRuns: 100 }
      );
    });

    it('Reddit sources require subreddit', () => {
      fc.assert(
        fc.property(validRedditConfigArb, (config) => {
          // Reddit config with subreddit should pass
          const result: ContentSourceValidationResult = validateContentSourceConfig(config);
          expect(result.valid).toBe(true);
          
          // Reddit config without subreddit should fail
          const configWithoutSubreddit = {
            type: config.type,
            url: config.url,
          };
          const resultWithoutSubreddit: ContentSourceValidationResult = validateContentSourceConfig(configWithoutSubreddit);
          expect(resultWithoutSubreddit.valid).toBe(false);
          expect(resultWithoutSubreddit.errors.some(e => e.includes('Subreddit') || e.includes('subreddit'))).toBe(true);
        }),
        { numRuns: 100 }
      );
    });

    it('News API sources require apiKey', () => {
      fc.assert(
        fc.property(validNewsApiConfigArb, (config) => {
          // News API config with apiKey should pass
          const result: ContentSourceValidationResult = validateContentSourceConfig(config);
          expect(result.valid).toBe(true);
          
          // News API config without apiKey should fail
          const configWithoutApiKey = {
            type: config.type,
            url: config.url,
          };
          const resultWithoutApiKey: ContentSourceValidationResult = validateContentSourceConfig(configWithoutApiKey);
          expect(resultWithoutApiKey.valid).toBe(false);
          expect(resultWithoutApiKey.errors.some(e => e.includes('API key') || e.includes('apiKey'))).toBe(true);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Multiple sources with same type', () => {
    it('multiple RSS sources can all be valid', () => {
      fc.assert(
        fc.property(
          fc.array(validRssConfigArb, { minLength: 2, maxLength: 5 }),
          (configs) => {
            // All RSS configs should be valid
            for (const config of configs) {
              const result: ContentSourceValidationResult = validateContentSourceConfig(config);
              expect(result.valid).toBe(true);
              expect(config.type).toBe('rss');
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('multiple Reddit sources can all be valid', () => {
      fc.assert(
        fc.property(
          fc.array(validRedditConfigArb, { minLength: 2, maxLength: 5 }),
          (configs) => {
            // All Reddit configs should be valid
            for (const config of configs) {
              const result: ContentSourceValidationResult = validateContentSourceConfig(config);
              expect(result.valid).toBe(true);
              expect(config.type).toBe('reddit');
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('multiple News API sources can all be valid', () => {
      fc.assert(
        fc.property(
          fc.array(validNewsApiConfigArb, { minLength: 2, maxLength: 5 }),
          (configs) => {
            // All News API configs should be valid
            for (const config of configs) {
              const result: ContentSourceValidationResult = validateContentSourceConfig(config);
              expect(result.valid).toBe(true);
              expect(config.type).toBe('news_api');
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Mixed source types collection', () => {
    it('a collection of mixed source types all validate correctly', () => {
      // Generator for a mixed collection of 1-10 sources of various types
      const mixedSourcesArb = fc.array(
        fc.oneof(validRssConfigArb, validRedditConfigArb, validNewsApiConfigArb),
        { minLength: 1, maxLength: 10 }
      );

      fc.assert(
        fc.property(mixedSourcesArb, (configs) => {
          // Track which types we've seen
          const seenTypes = new Set<string>();
          
          // All configs should be valid
          for (const config of configs) {
            const result: ContentSourceValidationResult = validateContentSourceConfig(config);
            expect(result.valid).toBe(true);
            expect(result.errors.length).toBe(0);
            
            // Track the type
            seenTypes.add(config.type);
            
            // Type should be one of the supported types
            expect(SUPPORTED_SOURCE_TYPES).toContain(config.type);
          }
          
          // We should have at least one source
          expect(configs.length).toBeGreaterThan(0);
        }),
        { numRuns: 100 }
      );
    });

    it('source configurations preserve their type after validation', () => {
      fc.assert(
        fc.property(allSourceTypesConfigArb, ([rssConfig, redditConfig, newsApiConfig]) => {
          // Validate each config
          validateContentSourceConfig(rssConfig);
          validateContentSourceConfig(redditConfig);
          validateContentSourceConfig(newsApiConfig);
          
          // Types should still be correct after validation
          expect(rssConfig.type).toBe('rss');
          expect(redditConfig.type).toBe('reddit');
          expect(newsApiConfig.type).toBe('news_api');
        }),
        { numRuns: 100 }
      );
    });
  });
});
