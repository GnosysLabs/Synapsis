const FEED_CURSOR_PREFIX = 'feed:';

export function encodeFeedCursor(value: string | number | Date | null | undefined): string | null {
  if (value == null) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? `${FEED_CURSOR_PREFIX}${timestamp}` : null;
}

export function decodeFeedCursor(cursor: string | null): Date | null {
  if (!cursor?.startsWith(FEED_CURSOR_PREFIX)) return null;

  const timestamp = Number(cursor.slice(FEED_CURSOR_PREFIX.length));
  if (!Number.isFinite(timestamp)) return null;

  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
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
} {
  const ordered = [...posts].sort((a, b) => feedActivityDate(b).getTime() - feedActivityDate(a).getTime());
  const selected = ordered.slice(0, limit);

  return {
    posts: selected,
    hasOverflow: ordered.length > selected.length,
    oldestActivityAt: selected.length > 0 ? feedActivityDate(selected[selected.length - 1]) : null,
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
