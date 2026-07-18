const SQLITE_LOCK_RETRY_DELAYS_MS = [2, 4, 8, 16, 24, 32] as const;

function isSqliteLockError(error: unknown): boolean {
  let candidate: unknown = error;
  for (let depth = 0; depth < 5 && candidate; depth += 1) {
    if (candidate instanceof Error
      && /database (?:is locked|is busy)/i.test(candidate.message)) {
      return true;
    }
    candidate = typeof candidate === 'object' && candidate !== null && 'cause' in candidate
      ? (candidate as { cause?: unknown }).cause
      : null;
  }
  return false;
}

/** Retry a short, atomic SQLite write when another process owns the writer lock. */
export async function withSqliteLockRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const retryDelay = SQLITE_LOCK_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined || !isSqliteLockError(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelay));
    }
  }
}
