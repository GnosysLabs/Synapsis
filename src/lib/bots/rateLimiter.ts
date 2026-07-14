/**
 * Rate Limiter Service
 * 
 * Enforces posting and reply rate limits for bots to prevent spam and abuse.
 * Tracks post counts per day and reply counts per hour.
 * 
 * Requirements: 5.6, 7.6, 10.1, 10.2, 10.4
 */

import { db, bots, botRateLimits, botActivityLogs } from '@/db';
import { eq, and, gte, desc } from 'drizzle-orm';

// ============================================
// RATE LIMIT CONSTANTS
// ============================================

export const RATE_LIMITS = {
  /** Maximum posts per bot per day (Requirement 10.1) */
  MAX_POSTS_PER_DAY: 50,
  /** Minimum interval between posts in minutes (Requirement 10.2) */
  MIN_POST_INTERVAL_MINUTES: 5,
  /** Maximum replies per bot per hour (Requirement 7.6) */
  MAX_REPLIES_PER_HOUR: 20,
} as const;

// ============================================
// TYPES
// ============================================

export interface RateLimitCheckResult {
  /** Whether the action is allowed */
  allowed: boolean;
  /** Reason for denial if not allowed */
  reason?: string;
  /** Seconds until the action would be allowed (for retry-after headers) */
  retryAfterSeconds?: number;
}

export interface RemainingQuota {
  /** Remaining posts for the current day */
  daily: number;
  /** Remaining replies for the current hour */
  hourly: number;
  /** Seconds until next post is allowed (0 if allowed now) */
  nextPostAllowedInSeconds: number;
}

export type WindowType = 'daily' | 'hourly';

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get the start of the current day (UTC midnight).
 */
export function getDailyWindowStart(date: Date = new Date()): Date {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

/**
 * Get the start of the current hour.
 */
export function getHourlyWindowStart(date: Date = new Date()): Date {
  const start = new Date(date);
  start.setUTCMinutes(0, 0, 0);
  return start;
}

/**
 * Calculate seconds until the minimum post interval has passed.
 */
function getSecondsUntilNextPostAllowed(lastPostAt: Date | null): number {
  if (!lastPostAt) {
    return 0;
  }
  
  const minIntervalMs = RATE_LIMITS.MIN_POST_INTERVAL_MINUTES * 60 * 1000;
  const nextAllowedTime = new Date(lastPostAt.getTime() + minIntervalMs);
  const now = new Date();
  
  if (nextAllowedTime <= now) {
    return 0;
  }
  
  return Math.ceil((nextAllowedTime.getTime() - now.getTime()) / 1000);
}

/**
 * Log a rate limit violation to the activity log.
 * Requirement 10.4: Log violations when rate limits are exceeded.
 */
async function logRateLimitViolation(
  botId: string,
  action: 'post' | 'reply',
  reason: string
): Promise<void> {
  try {
    await db.insert(botActivityLogs).values({
      botId,
      action: 'rate_limited',
      details: JSON.stringify({
        attemptedAction: action,
        reason,
        timestamp: new Date().toISOString(),
      }),
      success: false,
      errorMessage: reason,
    });
  } catch (error) {
    // Don't throw on logging failure - rate limiting should still work
    console.error('Failed to log rate limit violation:', error);
  }
}

// ============================================
// RATE LIMIT WINDOW MANAGEMENT
// ============================================

/**
 * Get or create a rate limit window record for a bot.
 */
async function getOrCreateWindow(
  botId: string,
  windowType: WindowType,
  windowStart: Date
): Promise<typeof botRateLimits.$inferSelect> {
  // Try to find existing window
  const existing = await db.query.botRateLimits.findFirst({
    where: { AND: [{ botId }, { windowType }, { windowStart: { eq: windowStart } }] },
  });
  
  if (existing) {
    return existing;
  }
  
  // Create new window
  const [created] = await db.insert(botRateLimits).values({
    botId,
    windowType,
    windowStart,
    postCount: 0,
    replyCount: 0,
  }).returning();
  
  return created;
}

/**
 * Get the current post count for a bot in the daily window.
 */
async function getDailyPostCount(botId: string): Promise<number> {
  const windowStart = getDailyWindowStart();
  const window = await db.query.botRateLimits.findFirst({
    where: { AND: [{ botId }, { windowType: 'daily' }, { windowStart: { eq: windowStart } }] },
  });
  
  return window?.postCount ?? 0;
}

/**
 * Get the current reply count for a bot in the hourly window.
 */
async function getHourlyReplyCount(botId: string): Promise<number> {
  const windowStart = getHourlyWindowStart();
  const window = await db.query.botRateLimits.findFirst({
    where: { AND: [{ botId }, { windowType: 'hourly' }, { windowStart: { eq: windowStart } }] },
  });
  
  return window?.replyCount ?? 0;
}

/**
 * Get the last post timestamp for a bot.
 */
async function getLastPostAt(botId: string): Promise<Date | null> {
  const bot = await db.query.bots.findFirst({
    where: { id: botId },
    columns: { lastPostAt: true },
  });
  
  return bot?.lastPostAt ?? null;
}

// ============================================
// RATE LIMITER FUNCTIONS
// ============================================

/**
 * Check if a bot can create a new post.
 * 
 * Enforces:
 * - Maximum 50 posts per day (Requirement 10.1)
 * - Minimum 5 minute interval between posts (Requirement 10.2, 5.6)
 * 
 * @param botId - The ID of the bot
 * @returns Result indicating if posting is allowed
 * 
 * Validates: Requirements 5.6, 10.1, 10.2, 10.4
 */
export async function canPost(botId: string): Promise<RateLimitCheckResult> {
  // Check minimum interval between posts (Requirement 10.2, 5.6)
  const lastPostAt = await getLastPostAt(botId);
  const secondsUntilAllowed = getSecondsUntilNextPostAllowed(lastPostAt);
  
  if (secondsUntilAllowed > 0) {
    const reason = `Minimum interval not met. Please wait ${secondsUntilAllowed} seconds before posting again.`;
    await logRateLimitViolation(botId, 'post', reason);
    return {
      allowed: false,
      reason,
      retryAfterSeconds: secondsUntilAllowed,
    };
  }
  
  // Check daily post limit (Requirement 10.1)
  const dailyPostCount = await getDailyPostCount(botId);
  
  if (dailyPostCount >= RATE_LIMITS.MAX_POSTS_PER_DAY) {
    // Calculate seconds until midnight UTC
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    const secondsUntilReset = Math.ceil((tomorrow.getTime() - now.getTime()) / 1000);
    
    const reason = `Daily post limit of ${RATE_LIMITS.MAX_POSTS_PER_DAY} reached. Resets at midnight UTC.`;
    await logRateLimitViolation(botId, 'post', reason);
    return {
      allowed: false,
      reason,
      retryAfterSeconds: secondsUntilReset,
    };
  }
  
  return { allowed: true };
}

/**
 * Check if a bot can create a new reply.
 * 
 * Enforces:
 * - Maximum 20 replies per hour (Requirement 7.6)
 * 
 * @param botId - The ID of the bot
 * @returns Result indicating if replying is allowed
 * 
 * Validates: Requirements 7.6, 10.4
 */
export async function canReply(botId: string): Promise<RateLimitCheckResult> {
  // Check hourly reply limit (Requirement 7.6)
  const hourlyReplyCount = await getHourlyReplyCount(botId);
  
  if (hourlyReplyCount >= RATE_LIMITS.MAX_REPLIES_PER_HOUR) {
    // Calculate seconds until next hour
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setUTCHours(nextHour.getUTCHours() + 1);
    nextHour.setUTCMinutes(0, 0, 0);
    const secondsUntilReset = Math.ceil((nextHour.getTime() - now.getTime()) / 1000);
    
    const reason = `Hourly reply limit of ${RATE_LIMITS.MAX_REPLIES_PER_HOUR} reached. Resets at the top of the hour.`;
    await logRateLimitViolation(botId, 'reply', reason);
    return {
      allowed: false,
      reason,
      retryAfterSeconds: secondsUntilReset,
    };
  }
  
  return { allowed: true };
}

/**
 * Record a post action for rate limiting.
 * Updates the daily post count and the bot's lastPostAt timestamp.
 * 
 * @param botId - The ID of the bot
 * 
 * Validates: Requirements 5.6, 10.1, 10.2
 */
export async function recordPost(botId: string): Promise<void> {
  const windowStart = getDailyWindowStart();
  
  // Get or create the daily window
  const window = await getOrCreateWindow(botId, 'daily', windowStart);
  
  // Increment post count
  await db
    .update(botRateLimits)
    .set({ postCount: window.postCount + 1 })
    .where(eq(botRateLimits.id, window.id));
  
  // Update bot's lastPostAt timestamp
  await db
    .update(bots)
    .set({ lastPostAt: new Date(), updatedAt: new Date() })
    .where(eq(bots.id, botId));
}

/**
 * Record a reply action for rate limiting.
 * Updates the hourly reply count.
 * 
 * @param botId - The ID of the bot
 * 
 * Validates: Requirements 7.6
 */
export async function recordReply(botId: string): Promise<void> {
  const windowStart = getHourlyWindowStart();
  
  // Get or create the hourly window
  const window = await getOrCreateWindow(botId, 'hourly', windowStart);
  
  // Increment reply count
  await db
    .update(botRateLimits)
    .set({ replyCount: window.replyCount + 1 })
    .where(eq(botRateLimits.id, window.id));
}

/**
 * Get the remaining quota for a bot.
 * 
 * @param botId - The ID of the bot
 * @returns Remaining daily posts and hourly replies
 * 
 * Validates: Requirements 5.6, 7.6, 10.1, 10.2
 */
export async function getRemainingQuota(botId: string): Promise<RemainingQuota> {
  const [dailyPostCount, hourlyReplyCount, lastPostAt] = await Promise.all([
    getDailyPostCount(botId),
    getHourlyReplyCount(botId),
    getLastPostAt(botId),
  ]);
  
  return {
    daily: Math.max(0, RATE_LIMITS.MAX_POSTS_PER_DAY - dailyPostCount),
    hourly: Math.max(0, RATE_LIMITS.MAX_REPLIES_PER_HOUR - hourlyReplyCount),
    nextPostAllowedInSeconds: getSecondsUntilNextPostAllowed(lastPostAt),
  };
}

/**
 * Get the post count for a bot within a specified time window.
 * 
 * @param botId - The ID of the bot
 * @param windowHours - Number of hours to look back
 * @returns Total post count in the window
 */
export async function getPostCount(botId: string, windowHours: number): Promise<number> {
  const windowStart = new Date();
  windowStart.setTime(windowStart.getTime() - windowHours * 60 * 60 * 1000);
  
  // Get all daily windows that overlap with the requested time range
  const windows = await db.query.botRateLimits.findMany({
    where: { AND: [{ botId: botId }, { windowType: 'daily' }, { windowStart: { gte: getDailyWindowStart(windowStart) } }] },
  });
  
  return windows.reduce((sum, w) => sum + w.postCount, 0);
}

/**
 * Reset rate limits for a bot (for testing or admin purposes).
 * 
 * @param botId - The ID of the bot
 */
export async function resetRateLimits(botId: string): Promise<void> {
  await db.delete(botRateLimits).where(eq(botRateLimits.botId, botId));
}
