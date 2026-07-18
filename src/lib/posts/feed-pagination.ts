const FEED_CURSOR_PREFIX = 'feed:';
const FEED_CURSOR_V2_PREFIX = 'feed:v2:';

export interface FeedCursorPosition {
  at: Date;
  id: string | null;
}

export function encodeFeedCursor(
  value: string | number | Date | { at: string | number | Date; id: string } | null | undefined,
): string | null {
  if (value == null) return null;
  if (typeof value === 'object' && !(value instanceof Date) && 'at' in value) {
    const timestamp = new Date(value.at).getTime();
    const id = value.id.slice(0, 1_024);
    return Number.isFinite(timestamp) && id
      ? `${FEED_CURSOR_V2_PREFIX}${timestamp}:${encodeURIComponent(id)}`
      : null;
  }
  const timestamp = new Date(value as string | number | Date).getTime();
  return Number.isFinite(timestamp) ? `${FEED_CURSOR_PREFIX}${timestamp}` : null;
}

export function decodeFeedCursorPosition(cursor: string | null): FeedCursorPosition | null {
  if (!cursor?.startsWith(FEED_CURSOR_PREFIX)) return null;
  if (cursor.startsWith(FEED_CURSOR_V2_PREFIX)) {
    const remainder = cursor.slice(FEED_CURSOR_V2_PREFIX.length);
    const separator = remainder.indexOf(':');
    if (separator <= 0) return null;
    const timestamp = Number(remainder.slice(0, separator));
    let id: string;
    try {
      id = decodeURIComponent(remainder.slice(separator + 1));
    } catch {
      return null;
    }
    const at = new Date(timestamp);
    return Number.isFinite(timestamp) && !Number.isNaN(at.getTime()) && id
      ? { at, id }
      : null;
  }

  const timestamp = Number(cursor.slice(FEED_CURSOR_PREFIX.length));
  if (!Number.isFinite(timestamp)) return null;

  const at = new Date(timestamp);
  return Number.isNaN(at.getTime()) ? null : { at, id: null };
}

export function decodeFeedCursor(cursor: string | null): Date | null {
  return decodeFeedCursorPosition(cursor)?.at ?? null;
}

interface FeedTimestamped {
  createdAt: string | number | Date;
  feedActivityAt?: string;
}

export function feedActivityDate(post: FeedTimestamped): Date {
  return new Date(post.feedActivityAt || post.createdAt);
}

export function selectFeedWindow<T extends FeedTimestamped>(posts: T[], limit: number): {
  posts: T[];
  hasOverflow: boolean;
  oldestActivityAt: Date | null;
  oldestPostId: string | null;
} {
  const ordered = [...posts].sort((a, b) => {
    const byActivity = feedActivityDate(b).getTime() - feedActivityDate(a).getTime();
    if (byActivity !== 0) return byActivity;
    const aId = 'id' in a ? String(a.id) : '';
    const bId = 'id' in b ? String(b.id) : '';
    return bId.localeCompare(aId);
  });
  const selected = ordered.slice(0, limit);
  const oldest = selected.at(-1);

  return {
    posts: selected,
    hasOverflow: ordered.length > selected.length,
    oldestActivityAt: oldest ? feedActivityDate(oldest) : null,
    oldestPostId: oldest && 'id' in oldest ? String(oldest.id) : null,
  };
}

/**
 * A global timestamp cursor must stop at the newest boundary among sources
 * that returned a full page. Older exhausted sources may safely repeat, while
 * advancing past this boundary would skip unseen posts from a busy source.
 */
export function getSourceContinuationDate<T extends FeedTimestamped>(
  sources: Array<{ posts: T[] }>,
  pageSize: number,
): Date | null {
  const boundaries = sources
    .filter((source) => source.posts.length >= pageSize)
    .map((source) => source.posts.reduce<Date | null>((oldest, post) => {
      const date = feedActivityDate(post);
      return !oldest || date < oldest ? date : oldest;
    }, null))
    .filter((date): date is Date => date !== null && Number.isFinite(date.getTime()));

  if (boundaries.length === 0) return null;
  return boundaries.reduce((newest, boundary) => boundary > newest ? boundary : newest);
}

export function newestDate(dates: Array<Date | null | undefined>): Date | null {
  const validDates = dates.filter((date): date is Date => Boolean(date && Number.isFinite(date.getTime())));
  if (validDates.length === 0) return null;
  return validDates.reduce((newest, date) => date > newest ? date : newest);
}
