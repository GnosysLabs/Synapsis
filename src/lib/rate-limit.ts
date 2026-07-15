/**
 * In-memory rate limiting for signed actions
 * 
 * Features:
 * - Sliding window approach (5 requests per minute per DID by default)
 * - Automatic cleanup to prevent memory leaks
 * - No external dependencies (Redis-free)
 */

// Map to store timestamps per DID: did -> array of request timestamps
const rateLimits = new Map<string, number[]>();

// Configuration for cleanup
const CLEANUP_INTERVAL_MS = 60 * 1000; // Run cleanup every minute
const MAX_IDLE_DID_MS = 10 * 60 * 1000; // Remove DIDs with no recent activity after 10 minutes
const MAX_RATE_LIMIT_KEYS = 10_000;

function evictOldestKey(): void {
  let oldestKey: string | null = null;
  let oldestTimestamp = Number.POSITIVE_INFINITY;
  for (const [key, timestamps] of rateLimits) {
    const newest = timestamps.at(-1) ?? 0;
    if (newest < oldestTimestamp) {
      oldestTimestamp = newest;
      oldestKey = key;
    }
  }
  if (oldestKey) rateLimits.delete(oldestKey);
}

/**
 * Check if a DID is rate limited
 * @param did - The DID to check
 * @param maxRequests - Maximum requests allowed in the window (default: 5)
 * @param windowMs - Time window in milliseconds (default: 60000 = 1 minute)
 * @returns true if rate limited, false otherwise
 */
export function isRateLimited(did: string, maxRequests = 5, windowMs = 60000): boolean {
  const now = Date.now();
  if (!rateLimits.has(did) && rateLimits.size >= MAX_RATE_LIMIT_KEYS) evictOldestKey();
  const timestamps = rateLimits.get(did) || [];
  
  // Filter to only keep timestamps within the window (sliding window)
  const recent = timestamps.filter(ts => now - ts < windowMs);
  
  // Check if limit exceeded
  if (recent.length >= maxRequests) {
    return true;
  }
  
  // Add current timestamp and update the map
  recent.push(now);
  rateLimits.set(did, recent);
  
  return false;
}

/**
 * Get current rate limit status for a DID
 * Useful for logging/debugging
 */
export function getRateLimitStatus(did: string, maxRequests = 5, windowMs = 60000): {
  limited: boolean;
  remaining: number;
  resetInMs: number;
  current: number;
} {
  const now = Date.now();
  const timestamps = rateLimits.get(did) || [];
  const recent = timestamps.filter(ts => now - ts < windowMs);
  
  const limited = recent.length >= maxRequests;
  const remaining = Math.max(0, maxRequests - recent.length);
  
  // Calculate when the oldest request will expire
  const oldestInWindow = recent.length > 0 ? Math.min(...recent) : now;
  const resetInMs = limited ? (oldestInWindow + windowMs - now) : 0;
  
  return {
    limited,
    remaining,
    resetInMs,
    current: recent.length
  };
}

/**
 * Cleanup old entries to prevent memory leaks
 * Removes:
 * 1. Timestamps outside the rate limit window for each DID
 * 2. DIDs with no recent activity (idle for MAX_IDLE_DID_MS)
 */
export function cleanupRateLimits(windowMs = 60000): {
  didsRemoved: number;
  timestampsRemoved: number;
} {
  const now = Date.now();
  let didsRemoved = 0;
  let timestampsRemoved = 0;
  
  for (const [did, timestamps] of rateLimits.entries()) {
    // Filter to keep only recent timestamps
    const recent = timestamps.filter(ts => {
      const isRecent = now - ts < windowMs;
      if (!isRecent) timestampsRemoved++;
      return isRecent;
    });
    
    if (recent.length === 0) {
      // Remove DID entirely if no recent activity
      // Also check if DID has been idle for too long
      const lastActivity = timestamps.length > 0 ? Math.max(...timestamps) : 0;
      if (now - lastActivity > MAX_IDLE_DID_MS) {
        rateLimits.delete(did);
        didsRemoved++;
      } else {
        rateLimits.set(did, recent);
      }
    } else {
      rateLimits.set(did, recent);
    }
  }
  
  return { didsRemoved, timestampsRemoved };
}

/**
 * Get current size of rate limit store (for monitoring)
 */
export function getRateLimitStoreSize(): {
  didCount: number;
  totalTimestamps: number;
} {
  let totalTimestamps = 0;
  for (const timestamps of rateLimits.values()) {
    totalTimestamps += timestamps.length;
  }
  
  return {
    didCount: rateLimits.size,
    totalTimestamps
  };
}

// Start periodic cleanup to prevent memory leaks
setInterval(() => {
  const result = cleanupRateLimits();
  if (result.didsRemoved > 0 || result.timestampsRemoved > 0) {
    console.log(`[RateLimit] Cleanup: removed ${result.didsRemoved} DIDs, ${result.timestampsRemoved} old timestamps`);
  }
}, CLEANUP_INTERVAL_MS);

console.log('[RateLimit] Initialized with sliding window rate limiting');
