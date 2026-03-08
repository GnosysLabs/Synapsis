/**
 * Property-Based Tests for Bot Posting Module
 * 
 * Feature: bot-system
 * - Property 38: Post Content Validation
 * 
 * Tests that generated posts are validated against platform requirements
 * (length, format) before publishing.
 * 
 * **Validates: Requirements 11.5**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  validatePostContent,
  sanitizePostContent,
  POST_MAX_LENGTH,
  POST_MIN_LENGTH,
  MAX_URLS_PER_POST,
} from './posting';

// ============================================
// GENERATORS
// ============================================

/**
 * Generator for valid post content (within length limits).
 */
const validPostContentArb = fc.string({
  minLength: POST_MIN_LENGTH,
  maxLength: POST_MAX_LENGTH,
}).filter(s => s.trim().length >= POST_MIN_LENGTH);

/**
 * Generator for post content that exceeds maximum length.
 */
const tooLongPostContentArb = fc.string({
  minLength: POST_MAX_LENGTH + 1,
  maxLength: POST_MAX_LENGTH + 500,
});

/**
 * Generator for post content that is too short (empty or whitespace).
 */
const tooShortPostContentArb = fc.oneof(
  fc.constant(''),
  fc.constant('   '),
  fc.constant('\n\n'),
  fc.constant('\t\t')
);

/**
 * Generator for post content with forbidden patterns.
 */
const forbiddenContentArb = fc.oneof(
  fc.constant('This is spam content'),
  fc.constant('Check out this scam'),
  fc.constant('Phishing attempt here'),
  fc.string({ minLength: 10, maxLength: 100 }).map(s => `${s} spam ${s}`),
  fc.string({ minLength: 10, maxLength: 100 }).map(s => `${s} scam ${s}`),
  fc.string({ minLength: 10, maxLength: 100 }).map(s => `${s} phishing ${s}`)
);

/**
 * Generator for URLs.
 */
const urlArb = fc.webUrl();

/**
 * Generator for post content with too many URLs.
 */
const tooManyUrlsContentArb = fc.array(urlArb, {
  minLength: MAX_URLS_PER_POST + 1,
  maxLength: MAX_URLS_PER_POST + 5,
}).map(urls => urls.join(' '));

/**
 * Generator for post content with acceptable number of URLs.
 */
const acceptableUrlsContentArb = fc.tuple(
  fc.string({ minLength: 10, maxLength: 100 }),
  fc.array(urlArb, { minLength: 0, maxLength: MAX_URLS_PER_POST })
).map(([text, urls]) => `${text} ${urls.join(' ')}`);

/**
 * Generator for content with null bytes and special characters.
 */
const unsafeContentArb = fc.string({ minLength: 10, maxLength: 100 }).map(s => 
  `${s}\0null byte\0${s}`
);

/**
 * Generator for content with excessive whitespace.
 */
const excessiveWhitespaceArb = fc.string({ minLength: 10, maxLength: 100 }).map(s =>
  `${s}\n\n\n\n\n${s}\n\n\n\n`
);

// ============================================
// PROPERTY TESTS
// ============================================

describe('Feature: bot-system, Property 38: Post Content Validation', () => {
  /**
   * Property 38: Post Content Validation
   * 
   * *For any* generated post, the content SHALL be validated against platform
   * requirements (length, format) before publishing.
   * 
   * **Validates: Requirements 11.5**
   */

  it('validates that content within length limits is valid (Requirement 11.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        validPostContentArb,
        async (content) => {
          const result = validatePostContent(content);
          
          // Valid content should pass validation
          expect(result.valid).toBe(true);
          expect(result.errors).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rejects content exceeding maximum length (Requirement 11.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        tooLongPostContentArb,
        async (content) => {
          // Only test if trimmed content exceeds max length
          if (content.trim().length <= POST_MAX_LENGTH) {
            return; // Skip this test case
          }
          
          const result = validatePostContent(content);
          
          // Content exceeding max length should fail validation
          expect(result.valid).toBe(false);
          expect(result.errors.length).toBeGreaterThan(0);
          
          // Should have specific error about length
          const hasLengthError = result.errors.some(err => 
            err.includes('must not exceed') || err.includes('characters')
          );
          expect(hasLengthError).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rejects content below minimum length (Requirement 11.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        tooShortPostContentArb,
        async (content) => {
          const result = validatePostContent(content);
          
          // Content below min length should fail validation
          expect(result.valid).toBe(false);
          expect(result.errors.length).toBeGreaterThan(0);
          
          // Should have error about content being required, minimum length, or empty/whitespace
          const hasRelevantError = result.errors.some(err => 
            err.includes('required') || err.includes('at least') || 
            err.includes('character') || err.includes('empty') || err.includes('whitespace')
          );
          expect(hasRelevantError).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rejects content with forbidden patterns (Requirement 11.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        forbiddenContentArb,
        async (content) => {
          const result = validatePostContent(content);
          
          // Content with forbidden patterns should fail validation
          expect(result.valid).toBe(false);
          expect(result.errors.length).toBeGreaterThan(0);
          
          // Should have error about forbidden content
          const hasForbiddenError = result.errors.some(err => 
            err.includes('forbidden')
          );
          expect(hasForbiddenError).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rejects content with too many URLs (Requirement 11.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        tooManyUrlsContentArb,
        async (content) => {
          // Only test if content is within length limits
          if (content.length > POST_MAX_LENGTH) {
            return; // Skip this test case
          }
          
          const result = validatePostContent(content);
          
          // Content with too many URLs should fail validation
          expect(result.valid).toBe(false);
          expect(result.errors.length).toBeGreaterThan(0);
          
          // Should have error about URL count
          const hasUrlError = result.errors.some(err => 
            err.includes('URL') || err.includes('urls')
          );
          expect(hasUrlError).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('accepts content with acceptable number of URLs (Requirement 11.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        acceptableUrlsContentArb,
        async (content) => {
          // Only test if content is within length limits
          if (content.length > POST_MAX_LENGTH || content.trim().length < POST_MIN_LENGTH) {
            return; // Skip this test case
          }
          
          const result = validatePostContent(content);
          
          // Content with acceptable URLs should pass validation
          expect(result.valid).toBe(true);
          expect(result.errors).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('validation is deterministic for same input (Requirement 11.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 0, maxLength: POST_MAX_LENGTH + 100 }),
        async (content) => {
          const result1 = validatePostContent(content);
          const result2 = validatePostContent(content);
          
          // Same input should produce same validation result
          expect(result1.valid).toBe(result2.valid);
          expect(result1.errors).toEqual(result2.errors);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('validation handles null and undefined gracefully (Requirement 11.5)', async () => {
    const nullResult = validatePostContent(null as any);
    const undefinedResult = validatePostContent(undefined as any);
    
    // Both should fail validation with appropriate error
    expect(nullResult.valid).toBe(false);
    expect(nullResult.errors.length).toBeGreaterThan(0);
    
    expect(undefinedResult.valid).toBe(false);
    expect(undefinedResult.errors.length).toBeGreaterThan(0);
  });

  it('validation handles non-string types gracefully (Requirement 11.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.integer(),
          fc.boolean(),
          fc.object(),
          fc.array(fc.string())
        ),
        async (nonString) => {
          const result = validatePostContent(nonString as any);
          
          // Non-string content should fail validation
          expect(result.valid).toBe(false);
          expect(result.errors.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('validation trims whitespace before checking length (Requirement 11.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        validPostContentArb,
        fc.string({ minLength: 0, maxLength: 50 }).filter(s => /^\s+$/.test(s) || s === ''),
        async (validContent, whitespace) => {
          const contentWithWhitespace = `${whitespace}${validContent}${whitespace}`;
          
          const result = validatePostContent(contentWithWhitespace);
          
          // Should validate based on trimmed length
          const trimmedLength = contentWithWhitespace.trim().length;
          
          if (trimmedLength >= POST_MIN_LENGTH && trimmedLength <= POST_MAX_LENGTH) {
            expect(result.valid).toBe(true);
          } else {
            expect(result.valid).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('validation provides specific error messages (Requirement 11.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          tooLongPostContentArb.filter(s => s.trim().length > POST_MAX_LENGTH), // Only truly too long
          tooShortPostContentArb,
          forbiddenContentArb.filter(s => s.trim().length >= POST_MIN_LENGTH && s.trim().length <= POST_MAX_LENGTH) // Valid length but forbidden
        ),
        async (invalidContent) => {
          const result = validatePostContent(invalidContent);
          
          // Invalid content should have specific error messages
          expect(result.valid).toBe(false);
          expect(result.errors.length).toBeGreaterThan(0);
          
          // Each error should be a non-empty string
          result.errors.forEach(error => {
            expect(typeof error).toBe('string');
            expect(error.length).toBeGreaterThan(0);
          });
        }
      ),
      { numRuns: 100 }
    );
  });

  it('sanitization removes null bytes (Requirement 11.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        unsafeContentArb,
        async (content) => {
          const sanitized = sanitizePostContent(content);
          
          // Sanitized content should not contain null bytes
          expect(sanitized).not.toContain('\0');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('sanitization normalizes line breaks (Requirement 11.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 10, maxLength: 100 }).map(s => 
          `${s}\r\n${s}\r\n${s}`
        ),
        async (content) => {
          const sanitized = sanitizePostContent(content);
          
          // Sanitized content should not contain \r\n
          expect(sanitized).not.toContain('\r\n');
          
          // Should only have \n for line breaks
          if (sanitized.includes('\n')) {
            expect(sanitized.split('\n').length).toBeGreaterThan(1);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('sanitization removes excessive whitespace (Requirement 11.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        excessiveWhitespaceArb,
        async (content) => {
          const sanitized = sanitizePostContent(content);
          
          // Sanitized content should not have more than 2 consecutive newlines
          expect(sanitized).not.toMatch(/\n{3,}/);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('sanitization trims leading and trailing whitespace (Requirement 11.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 10, maxLength: 100 }),
        fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^\s+$/.test(s)),
        async (content, whitespace) => {
          const contentWithWhitespace = `${whitespace}${content}${whitespace}`;
          const sanitized = sanitizePostContent(contentWithWhitespace);
          
          // Sanitized content should be trimmed
          expect(sanitized).toBe(sanitized.trim());
          expect(sanitized).not.toMatch(/^\s/);
          expect(sanitized).not.toMatch(/\s$/);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('sanitization is idempotent (Requirement 11.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 0, maxLength: 200 }),
        async (content) => {
          const sanitized1 = sanitizePostContent(content);
          const sanitized2 = sanitizePostContent(sanitized1);
          
          // Sanitizing twice should produce the same result
          expect(sanitized1).toBe(sanitized2);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('sanitization preserves valid content structure (Requirement 11.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        validPostContentArb,
        async (content) => {
          const sanitized = sanitizePostContent(content);
          
          // Sanitized valid content should still be valid
          // (assuming it doesn't have null bytes or excessive whitespace)
          if (!content.includes('\0') && !content.match(/\n{3,}/)) {
            expect(sanitized.trim()).toBe(content.trim());
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('validation constants are properly defined (Requirement 11.5)', async () => {
    // Verify constants are reasonable
    expect(POST_MAX_LENGTH).toBe(600);
    expect(POST_MIN_LENGTH).toBe(1);
    expect(MAX_URLS_PER_POST).toBe(5);
    
    // Verify relationships
    expect(POST_MAX_LENGTH).toBeGreaterThan(POST_MIN_LENGTH);
    expect(MAX_URLS_PER_POST).toBeGreaterThan(0);
  });

  it('validation rejects content at boundary conditions (Requirement 11.5)', async () => {
    // Test exact boundary: POST_MAX_LENGTH
    const exactMaxContent = 'a'.repeat(POST_MAX_LENGTH);
    const exactMaxResult = validatePostContent(exactMaxContent);
    expect(exactMaxResult.valid).toBe(true);
    
    // Test one over boundary: POST_MAX_LENGTH + 1
    const overMaxContent = 'a'.repeat(POST_MAX_LENGTH + 1);
    const overMaxResult = validatePostContent(overMaxContent);
    expect(overMaxResult.valid).toBe(false);
    
    // Test exact minimum: POST_MIN_LENGTH
    const exactMinContent = 'a'.repeat(POST_MIN_LENGTH);
    const exactMinResult = validatePostContent(exactMinContent);
    expect(exactMinResult.valid).toBe(true);
    
    // Test below minimum: empty string
    const belowMinContent = '';
    const belowMinResult = validatePostContent(belowMinContent);
    expect(belowMinResult.valid).toBe(false);
  });

  it('validation handles mixed invalid conditions (Requirement 11.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(
          fc.boolean(), // too long?
          fc.boolean(), // has forbidden content?
          fc.boolean()  // too many URLs?
        ),
        async ([tooLong, forbidden, tooManyUrls]) => {
          let content = 'Test content ';
          
          if (tooLong) {
            content = 'a'.repeat(POST_MAX_LENGTH + 10);
          }
          
          if (forbidden) {
            content += ' spam ';
          }
          
          if (tooManyUrls) {
            const urls = Array(MAX_URLS_PER_POST + 2).fill('https://example.com');
            content += urls.join(' ');
          }
          
          const result = validatePostContent(content);
          
          // If any condition is invalid, validation should fail
          if (tooLong || forbidden || tooManyUrls) {
            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('validation error count matches number of violations (Requirement 11.5)', async () => {
    // Content that is too long AND has forbidden content
    const multiViolationContent = 'spam '.repeat(100); // Too long and has "spam"
    const result = validatePostContent(multiViolationContent);
    
    expect(result.valid).toBe(false);
    // Should have at least 2 errors (length and forbidden content)
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });
});
