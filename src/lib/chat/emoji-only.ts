const emojiSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const keycapEmojiPattern = /^[#*0-9]\uFE0F?\u20E3$/u;
const flagEmojiPattern = /^\p{Regional_Indicator}{2}$/u;
const pictographicEmojiPattern = /^(?=[\s\S]*\p{Extended_Pictographic})[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0E\uFE0F\u200D\u{E0020}-\u{E007F}]+$/u;

function isEmojiGrapheme(value: string): boolean {
  return keycapEmojiPattern.test(value)
    || flagEmojiPattern.test(value)
    || pictographicEmojiPattern.test(value);
}

/**
 * Returns the number of emoji graphemes when a message contains only one to
 * three emoji. Whitespace between emoji is ignored for counting. Everything
 * else, including four or more emoji, uses the regular chat bubble.
 */
export function getEmojiOnlyCount(value: string): 1 | 2 | 3 | null {
  if (!value.trim()) return null;

  let count = 0;
  for (const { segment } of emojiSegmenter.segment(value.trim())) {
    if (/^\s+$/u.test(segment)) continue;
    if (!isEmojiGrapheme(segment)) return null;
    count += 1;
    if (count > 3) return null;
  }

  return count === 1 || count === 2 || count === 3 ? count : null;
}
