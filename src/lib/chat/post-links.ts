import { tokenizePostContent } from '@/lib/mentions/parser';
import {
  getCanonicalSwarmSeedDomain,
  normalizeNodeDomain,
} from '@/lib/swarm/node-domain';
import { parseSwarmPostId } from '@/lib/swarm/post-id';
import { canonicalAccountHomeDomain } from '@/lib/identity/account-address';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVELOPMENT_LOOPBACK_DOMAIN = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;
const MAX_CHAT_POST_CARDS = 4;

export interface ChatPostLink {
  url: string;
  postId: string;
  start: number;
  end: number;
}

function sourceNodeDomain(host: string): string | null {
  const normalized = normalizeNodeDomain(host);
  return getCanonicalSwarmSeedDomain(normalized)
    ?? (process.env.NODE_ENV === 'development' && DEVELOPMENT_LOOPBACK_DOMAIN.test(normalized)
      ? normalized
      : null);
}

export function parseChatPostLink(
  value: string,
  localNodeDomain: string,
): Omit<ChatPostLink, 'start' | 'end'> | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

    const pathMatch = url.pathname.match(/^\/u\/[^/]+\/posts\/([^/]+)\/?$/);
    if (!pathMatch) return null;
    const rawPostId = decodeURIComponent(pathMatch[1]);

    if (rawPostId.startsWith('swarm:')) {
      if (!parseSwarmPostId(rawPostId)) return null;
      return { url: url.toString(), postId: rawPostId };
    }
    if (!UUID_PATTERN.test(rawPostId)) return null;

    const sourceDomain = sourceNodeDomain(url.host);
    if (!sourceDomain) return null;
    const localDomain = canonicalAccountHomeDomain(localNodeDomain);
    if (!localDomain) return null;
    return {
      url: url.toString(),
      postId: sourceDomain === localDomain
        ? rawPostId
        : `swarm:${sourceDomain}:${rawPostId}`,
    };
  } catch {
    return null;
  }
}

export function findChatPostLinks(content: string, localNodeDomain: string): ChatPostLink[] {
  const links: ChatPostLink[] = [];
  const seenPostIds = new Set<string>();

  for (const token of tokenizePostContent(content, localNodeDomain)) {
    if (token.type !== 'url') continue;
    const parsed = parseChatPostLink(token.value, localNodeDomain);
    if (!parsed) continue;

    // Strip every duplicate URL occurrence from the text while rendering only
    // one card for the same post.
    if (seenPostIds.has(parsed.postId)) {
      links.push({ ...parsed, start: token.start, end: token.end });
      continue;
    }
    if (seenPostIds.size >= MAX_CHAT_POST_CARDS) continue;
    seenPostIds.add(parsed.postId);
    links.push({ ...parsed, start: token.start, end: token.end });
  }

  return links;
}

export function uniqueChatPostLinks(links: readonly ChatPostLink[]): ChatPostLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    if (seen.has(link.postId)) return false;
    seen.add(link.postId);
    return true;
  });
}

export function removeChatPostLinks(content: string, links: readonly ChatPostLink[]): string {
  if (links.length === 0) return content;
  const ordered = [...links].sort((left, right) => left.start - right.start);
  let result = '';
  let cursor = 0;
  for (const link of ordered) {
    if (link.start < cursor) continue;
    result += content.slice(cursor, link.start);
    cursor = link.end;
    if (result.endsWith('\n') && content[cursor] === '\n') {
      cursor += 1;
    } else if (/[ \t]$/.test(result)) {
      while (content[cursor] === ' ' || content[cursor] === '\t') cursor += 1;
    }
  }
  result += content.slice(cursor);

  return result.trim();
}
