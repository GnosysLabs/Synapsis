import { resolveUserHandle } from '@/lib/swarm/user-handle';
import { isValidNodeDomain } from '@/lib/utils/federation';

const HANDLE_PATTERN = /^[a-zA-Z0-9_]{3,30}$/;
const HANDLE_CHARACTER = /[a-zA-Z0-9_]/;
const MENTION_PATTERN = /@([a-zA-Z0-9_]{3,30})(?:@([a-zA-Z0-9.-]+(?::\d{1,5})?))?/g;
const URL_PATTERN = /https?:\/\/[^\s<]+/gi;

export interface ParsedMention {
  raw: string;
  start: number;
  end: number;
  handle: string;
  domain: string | null;
  canonicalHandle: string;
  isQualified: boolean;
  isLocal: boolean;
}

export interface ActiveMentionQuery {
  start: number;
  end: number;
  query: string;
  handleQuery: string;
  domainQuery: string | null;
}

export type RichTextToken =
  | { type: 'text'; value: string; start: number; end: number }
  | { type: 'url'; value: string; start: number; end: number }
  | ({ type: 'mention'; value: string } & ParsedMention);

function hasValidLeadingBoundary(content: string, start: number): boolean {
  if (start === 0) return true;
  return !/[a-zA-Z0-9_@.]/.test(content[start - 1]);
}

function isInsideUrlLikeToken(content: string, start: number): boolean {
  const tokenStart = Math.max(
    content.lastIndexOf(' ', start - 1),
    content.lastIndexOf('\n', start - 1),
    content.lastIndexOf('\t', start - 1),
  ) + 1;
  const prefix = content.slice(tokenStart, start).toLowerCase();
  return prefix.includes('://') || prefix.startsWith('mailto:');
}

function normalizeMatchedDomain(value: string): string | null {
  let candidate = value.toLowerCase();
  while (candidate.endsWith('.') && !isValidNodeDomain(candidate)) {
    candidate = candidate.slice(0, -1);
  }
  return isValidNodeDomain(candidate) ? candidate : null;
}

/**
 * Parse valid local and federated mentions with source ranges.
 *
 * The parser deliberately rejects email addresses, mentions embedded in URLs,
 * overlong handles, malformed domains, and partial qualified handles. Ranges
 * exclude sentence punctuation so rendering and composer replacement remain
 * exact.
 */
export function parseMentions(
  content: string,
  currentDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
): ParsedMention[] {
  const mentions: ParsedMention[] = [];
  MENTION_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = MENTION_PATTERN.exec(content)) !== null) {
    const start = match.index;
    const handle = match[1].toLowerCase();
    if (!HANDLE_PATTERN.test(handle)
      || !hasValidLeadingBoundary(content, start)
      || isInsideUrlLikeToken(content, start)) {
      continue;
    }

    const handleEnd = start + 1 + match[1].length;
    const rawDomain = match[2];
    const domain = rawDomain ? normalizeMatchedDomain(rawDomain) : null;

    // An explicit but malformed/partial domain must never fall back to a local
    // mention. That would notify the wrong person while the author is typing.
    if (rawDomain && !domain) continue;
    if (!rawDomain && content[handleEnd] === '@') continue;

    const end = domain
      ? handleEnd + 1 + domain.length
      : handleEnd;
    const next = content[end];

    if (next && HANDLE_CHARACTER.test(next)) continue;
    if (!domain && next === '.' && /[a-zA-Z0-9]/.test(content[end + 1] || '')) continue;

    const qualified = domain ? `${handle}@${domain}` : handle;
    const resolution = resolveUserHandle(qualified, currentDomain);

    mentions.push({
      raw: content.slice(start, end),
      start,
      end,
      handle,
      domain,
      canonicalHandle: resolution.canonicalHandle,
      isQualified: Boolean(domain),
      isLocal: resolution.isLocal,
    });
  }

  return mentions;
}

export function uniqueMentions(mentions: readonly ParsedMention[]): ParsedMention[] {
  const seen = new Set<string>();
  return mentions.filter((mention) => {
    const key = mention.canonicalHandle.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Return the mention fragment immediately before the caret, if any. */
export function getActiveMentionQuery(content: string, caret: number): ActiveMentionQuery | null {
  const safeCaret = Math.max(0, Math.min(caret, content.length));
  const beforeCaret = content.slice(0, safeCaret);
  const match = beforeCaret.match(/(?:^|[^a-zA-Z0-9_@.])@([a-zA-Z0-9_]{0,30})(?:@([a-zA-Z0-9.-]*(?::\d{0,5})?))?$/);
  if (!match || match.index === undefined) return null;

  const boundaryLength = match[0].startsWith('@') ? 0 : 1;
  const start = match.index + boundaryLength;
  if (isInsideUrlLikeToken(content, start)) return null;

  const handleQuery = match[1] || '';
  const domainQuery = match[2] === undefined ? null : match[2];
  return {
    start,
    end: safeCaret,
    query: domainQuery === null ? handleQuery : `${handleQuery}@${domainQuery}`,
    handleQuery,
    domainQuery,
  };
}

export function replaceMentionQuery(
  content: string,
  active: ActiveMentionQuery,
  replacement: string,
): { content: string; caret: number } {
  const normalizedReplacement = replacement.startsWith('@') ? replacement : `@${replacement}`;
  const needsSpace = active.end >= content.length || !/^\s/.test(content[active.end]);
  const inserted = `${normalizedReplacement}${needsSpace ? ' ' : ''}`;
  return {
    content: `${content.slice(0, active.start)}${inserted}${content.slice(active.end)}`,
    caret: active.start + inserted.length,
  };
}

function trimUrlEnd(value: string): string {
  let result = value;
  while (/[.,!?;:]$/.test(result)) result = result.slice(0, -1);
  while (result.endsWith(')')) {
    const opens = (result.match(/\(/g) || []).length;
    const closes = (result.match(/\)/g) || []).length;
    if (closes <= opens) break;
    result = result.slice(0, -1);
  }
  return result;
}

/** Tokenize post text while giving URLs precedence over mentions inside URLs. */
export function tokenizePostContent(
  content: string,
  currentDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
): RichTextToken[] {
  const ranges: Array<RichTextToken> = [];
  URL_PATTERN.lastIndex = 0;
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = URL_PATTERN.exec(content)) !== null) {
    const value = trimUrlEnd(urlMatch[0]);
    if (!value) continue;
    ranges.push({
      type: 'url',
      value,
      start: urlMatch.index,
      end: urlMatch.index + value.length,
    });
  }

  const urlRanges = ranges.filter((token) => token.type === 'url');
  for (const mention of parseMentions(content, currentDomain)) {
    const overlapsUrl = urlRanges.some((url) => mention.start < url.end && mention.end > url.start);
    if (!overlapsUrl) {
      ranges.push({ type: 'mention', value: mention.raw, ...mention });
    }
  }

  ranges.sort((left, right) => left.start - right.start || right.end - left.end);
  const tokens: RichTextToken[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) {
      tokens.push({ type: 'text', value: content.slice(cursor, range.start), start: cursor, end: range.start });
    }
    tokens.push(range);
    cursor = range.end;
  }
  if (cursor < content.length) {
    tokens.push({ type: 'text', value: content.slice(cursor), start: cursor, end: content.length });
  }
  return tokens;
}
