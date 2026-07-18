import { describe, expect, it } from 'vitest';

import { getEmojiOnlyCount } from './emoji-only';

describe('emoji-only chat messages', () => {
  it('counts one to three emoji graphemes', () => {
    expect(getEmojiOnlyCount('😀')).toBe(1);
    expect(getEmojiOnlyCount('😀 🚀')).toBe(2);
    expect(getEmojiOnlyCount('😀🚀✨')).toBe(3);
  });

  it('treats compound emoji as single graphemes', () => {
    expect(getEmojiOnlyCount('👨‍👩‍👧‍👦')).toBe(1);
    expect(getEmojiOnlyCount('👍🏽 🇺🇸')).toBe(2);
    expect(getEmojiOnlyCount('1️⃣2️⃣3️⃣')).toBe(3);
  });

  it('uses a regular bubble for text or more than three emoji', () => {
    expect(getEmojiOnlyCount('hello 😀')).toBeNull();
    expect(getEmojiOnlyCount('😀!')).toBeNull();
    expect(getEmojiOnlyCount('😀🚀✨❤️')).toBeNull();
    expect(getEmojiOnlyCount('   ')).toBeNull();
  });
});
