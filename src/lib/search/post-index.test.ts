import { describe, expect, it } from 'vitest';

import { tokenizePostSearch } from './post-index';

describe('tokenizePostSearch', () => {
  it('normalizes, deduplicates, and keeps Unicode words', () => {
    expect(tokenizePostSearch('Hello, HELLO — café 世界!')).toEqual([
      'hello',
      'café',
      '世界',
    ]);
  });

  it('bounds untrusted post content to 64 searchable terms', () => {
    const content = Array.from({ length: 100 }, (_, index) => `word${index}`).join(' ');
    expect(tokenizePostSearch(content)).toHaveLength(64);
  });
});
