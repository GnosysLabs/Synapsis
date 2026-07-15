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
