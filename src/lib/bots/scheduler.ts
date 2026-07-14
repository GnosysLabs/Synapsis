/**
 * Scheduler Service
 * 
 * Manages scheduled posting for bots. Supports interval-based, time-of-day,
 * and cron-like schedules. Integrates with rate limiter and content sources.
 * 
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

import { db, bots, botContentSources, botContentItems } from '@/db';
import { eq, and } from 'drizzle-orm';
import { canPost } from './rateLimiter';
import { triggerPost } from './posting';
import { fetchAllSourcesForBot } from './contentFetcher';

// ============================================
// TYPES
// ============================================

/**
 * Schedule configuration for a bot.
 * 
 * Validates: Requirements 5.1, 5.3
 */
export interface ScheduleConfig {
  /** Type of schedule */
  type: 'interval' | 'times' | 'cron';
  /** Interval in minutes (for interval type) */
  intervalMinutes?: number;
  /** Times of day in HH:MM format (for times type) */
  times?: string[];
  /** Cron expression (for cron type) */
  cronExpression?: string;
  /** Timezone for time-based schedules (default: UTC) */
  timezone?: string;
}

/**
 * Result of schedule validation.
 */
export interface ScheduleValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Result of checking if a schedule is due.
 */
export interface IsDueResult {
  isDue: boolean;
  reason?: string;
  nextDueAt?: Date;
}

/**
 * Result of processing scheduled posts.
 */
export interface ProcessScheduledPostsResult {
  processed: number;
  skipped: number;
  errors: string[];
  details: {
    botId: string;
    status: 'posted' | 'skipped_no_content' | 'skipped_rate_limit' | 'skipped_not_due' | 'error';
    message?: string;
  }[];
}

// ============================================
// CONSTANTS
// ============================================

/** Minimum interval in minutes */
export const MIN_INTERVAL_MINUTES = 5;

/** Maximum interval in minutes (7 days) */
export const MAX_INTERVAL_MINUTES = 10080;

/** Maximum times per day */
export const MAX_TIMES_PER_DAY = 24;

/** Time format regex (HH:MM) */
const TIME_FORMAT_REGEX = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/;

/** Cron expression regex (simplified: minute hour day month weekday) */
const CRON_REGEX = /^(\*|[0-5]?[0-9])\s+(\*|[01]?[0-9]|2[0-3])\s+(\*|[1-9]|[12][0-9]|3[01])\s+(\*|[1-9]|1[0-2])\s+(\*|[0-6])$/;

// ============================================
// VALIDATION FUNCTIONS
// ============================================

/**
 * Validate a time string in HH:MM format.
 * 
 * @param time - The time string to validate
 * @returns True if valid
 */
export function isValidTimeFormat(time: string): boolean {
  if (!time || typeof time !== 'string') {
    return false;
  }
  return TIME_FORMAT_REGEX.test(time.trim());
}

/**
 * Validate a cron expression.
 * Supports simplified cron format: minute hour day month weekday
 * 
 * @param expression - The cron expression to validate
 * @returns True if valid
 */
export function isValidCronExpression(expression: string): boolean {
  if (!expression || typeof expression !== 'string') {
    return false;
  }
  return CRON_REGEX.test(expression.trim());
}

/**
 * Validate interval minutes.
 * 
 * @param minutes - The interval in minutes
 * @returns Validation errors (empty if valid)
 */
export function validateIntervalMinutes(minutes: unknown): string[] {
  const errors: string[] = [];
  
  if (minutes === undefined || minutes === null) {
    errors.push('Interval minutes is required for interval schedules');
    return errors;
  }
  
  if (typeof minutes !== 'number') {
    errors.push('Interval minutes must be a number');
    return errors;
  }
  
  if (!Number.isInteger(minutes)) {
    errors.push('Interval minutes must be an integer');
    return errors;
  }
  
  if (minutes < MIN_INTERVAL_MINUTES) {
    errors.push(`Interval must be at least ${MIN_INTERVAL_MINUTES} minutes`);
  }
  
  if (minutes > MAX_INTERVAL_MINUTES) {
    errors.push(`Interval must be at most ${MAX_INTERVAL_MINUTES} minutes (7 days)`);
  }
  
  return errors;
}

/**
 * Validate times array.
 * 
 * @param times - The times array
 * @returns Validation errors (empty if valid)
 */
export function validateTimes(times: unknown): string[] {
  const errors: string[] = [];
  
  if (times === undefined || times === null) {
    errors.push('Times array is required for times schedules');
    return errors;
  }
  
  if (!Array.isArray(times)) {
    errors.push('Times must be an array');
    return errors;
  }
  
  if (times.length === 0) {
    errors.push('Times array cannot be empty');
    return errors;
  }
  
  if (times.length > MAX_TIMES_PER_DAY) {
    errors.push(`Maximum ${MAX_TIMES_PER_DAY} times per day allowed`);
  }
  
  const seenTimes = new Set<string>();
  
  for (let i = 0; i < times.length; i++) {
    const time = times[i];
    
    if (typeof time !== 'string') {
      errors.push(`Time at index ${i} must be a string`);
      continue;
    }
    
    const trimmed = time.trim();
    
    if (!isValidTimeFormat(trimmed)) {
      errors.push(`Time at index ${i} must be in HH:MM format (got: ${trimmed})`);
      continue;
    }
    
    // Normalize to HH:MM format
    const normalized = normalizeTime(trimmed);
    
    if (seenTimes.has(normalized)) {
      errors.push(`Duplicate time at index ${i}: ${normalized}`);
    } else {
      seenTimes.add(normalized);
    }
  }
  
  return errors;
}

/**
 * Validate cron expression.
 * 
 * @param expression - The cron expression
 * @returns Validation errors (empty if valid)
 */
export function validateCronExpression(expression: unknown): string[] {
  const errors: string[] = [];
  
  if (expression === undefined || expression === null) {
    errors.push('Cron expression is required for cron schedules');
    return errors;
  }
  
  if (typeof expression !== 'string') {
    errors.push('Cron expression must be a string');
    return errors;
  }
  
  const trimmed = expression.trim();
  
  if (!isValidCronExpression(trimmed)) {
    errors.push('Invalid cron expression format. Expected: minute hour day month weekday');
  }
  
  return errors;
}

/**
 * Validate a complete schedule configuration.
 * 
 * @param config - The schedule configuration to validate
 * @returns Validation result with errors
 * 
 * Validates: Requirements 5.1, 5.3
 */
export function validateScheduleConfig(config: unknown): ScheduleValidationResult {
  const errors: string[] = [];
  
  if (!config || typeof config !== 'object') {
    return {
      valid: false,
      errors: ['Schedule configuration must be an object'],
    };
  }
  
  const configObj = config as Record<string, unknown>;
  
  // Validate type
  if (!configObj.type || typeof configObj.type !== 'string') {
    errors.push('Schedule type is required');
    return { valid: false, errors };
  }
  
  const validTypes = ['interval', 'times', 'cron'];
  if (!validTypes.includes(configObj.type)) {
    errors.push(`Invalid schedule type: ${configObj.type}. Must be one of: ${validTypes.join(', ')}`);
    return { valid: false, errors };
  }
  
  // Type-specific validation
  switch (configObj.type) {
    case 'interval':
      errors.push(...validateIntervalMinutes(configObj.intervalMinutes));
      break;
      
    case 'times':
      errors.push(...validateTimes(configObj.times));
      break;
      
    case 'cron':
      errors.push(...validateCronExpression(configObj.cronExpression));
      break;
  }
  
  // Validate timezone if provided
  if (configObj.timezone !== undefined && configObj.timezone !== null) {
    if (typeof configObj.timezone !== 'string') {
      errors.push('Timezone must be a string');
    } else if (!isValidTimezone(configObj.timezone)) {
      errors.push(`Invalid timezone: ${configObj.timezone}`);
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Normalize a time string to HH:MM format.
 * 
 * @param time - The time string (H:MM or HH:MM)
 * @returns Normalized time string
 */
export function normalizeTime(time: string): string {
  const match = time.trim().match(TIME_FORMAT_REGEX);
  if (!match) {
    return time;
  }
  
  const hours = match[1].padStart(2, '0');
  const minutes = match[2];
  
  return `${hours}:${minutes}`;
}

/**
 * Check if a timezone string is valid.
 * 
 * @param timezone - The timezone string
 * @returns True if valid
 */
export function isValidTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current time in a specific timezone.
 * 
 * @param timezone - The timezone (default: UTC)
 * @returns Object with hours and minutes
 */
export function getCurrentTimeInTimezone(timezone: string = 'UTC'): { hours: number; minutes: number } {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  
  const parts = formatter.formatToParts(now);
  const hours = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
  const minutes = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
  
  return { hours, minutes };
}

/**
 * Parse a time string to hours and minutes.
 * 
 * @param time - The time string in HH:MM format
 * @returns Object with hours and minutes
 */
export function parseTime(time: string): { hours: number; minutes: number } {
  const normalized = normalizeTime(time);
  const [hours, minutes] = normalized.split(':').map(Number);
  return { hours, minutes };
}

/**
 * Parse a cron expression into its components.
 * 
 * @param expression - The cron expression
 * @returns Parsed cron components
 */
export function parseCronExpression(expression: string): {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
} {
  const parts = expression.trim().split(/\s+/);
  return {
    minute: parts[0] || '*',
    hour: parts[1] || '*',
    dayOfMonth: parts[2] || '*',
    month: parts[3] || '*',
    dayOfWeek: parts[4] || '*',
  };
}

/**
 * Check if a cron field matches a value.
 * 
 * @param field - The cron field (number or '*')
 * @param value - The value to check
 * @returns True if matches
 */
function cronFieldMatches(field: string, value: number): boolean {
  if (field === '*') {
    return true;
  }
  return parseInt(field, 10) === value;
}

// ============================================
// SCHEDULE STORAGE
// ============================================

/**
 * Parse a schedule configuration from JSON string.
 * 
 * @param json - The JSON string
 * @returns Parsed schedule config or null
 */
export function parseScheduleConfig(json: string | null): ScheduleConfig | null {
  if (!json) {
    return null;
  }
  
  try {
    const parsed = JSON.parse(json);
    const validation = validateScheduleConfig(parsed);
    
    if (!validation.valid) {
      return null;
    }
    
    return parsed as ScheduleConfig;
  } catch {
    return null;
  }
}

/**
 * Serialize a schedule configuration to JSON string.
 * 
 * @param config - The schedule configuration
 * @returns JSON string
 */
export function serializeScheduleConfig(config: ScheduleConfig): string {
  return JSON.stringify(config);
}

// ============================================
// IS DUE CHECK
// ============================================

/**
 * Check if an interval schedule is due.
 * 
 * @param intervalMinutes - The interval in minutes
 * @param lastPostAt - The last post timestamp
 * @returns IsDueResult
 */
export function isIntervalDue(
  intervalMinutes: number,
  lastPostAt: Date | null
): IsDueResult {
  // If never posted, it's due
  if (!lastPostAt) {
    return { isDue: true, reason: 'No previous post' };
  }
  
  const intervalMs = intervalMinutes * 60 * 1000;
  const nextDueAt = new Date(lastPostAt.getTime() + intervalMs);
  const now = new Date();
  
  if (now >= nextDueAt) {
    return { isDue: true, reason: 'Interval elapsed', nextDueAt };
  }
  
  return {
    isDue: false,
    reason: `Next post due at ${nextDueAt.toISOString()}`,
    nextDueAt,
  };
}

/**
 * Check if a time-of-day schedule is due.
 * 
 * @param times - Array of times in HH:MM format
 * @param timezone - The timezone (default: UTC)
 * @param lastPostAt - The last post timestamp
 * @returns IsDueResult
 */
export function isTimesDue(
  times: string[],
  timezone: string = 'UTC',
  lastPostAt: Date | null
): IsDueResult {
  const currentTime = getCurrentTimeInTimezone(timezone);
  const currentMinutes = currentTime.hours * 60 + currentTime.minutes;
  
  // Sort times and find the next due time
  const sortedTimes = times
    .map(t => parseTime(t))
    .map(t => ({ ...t, totalMinutes: t.hours * 60 + t.minutes }))
    .sort((a, b) => a.totalMinutes - b.totalMinutes);
  
  // Check if we're within a 5-minute window of any scheduled time
  for (const time of sortedTimes) {
    const diff = currentMinutes - time.totalMinutes;
    
    // Within 5 minutes after the scheduled time
    if (diff >= 0 && diff < 5) {
      // Check if we already posted for this time slot today
      if (lastPostAt) {
        const lastPostTime = getCurrentTimeInTimezone(timezone);
        const lastPostDate = new Date(lastPostAt);
        const now = new Date();
        
        // If last post was today and within this time window, skip
        if (
          lastPostDate.toDateString() === now.toDateString() &&
          Math.abs(lastPostDate.getTime() - now.getTime()) < 5 * 60 * 1000
        ) {
          continue;
        }
      }
      
      return {
        isDue: true,
        reason: `Scheduled time ${normalizeTime(`${time.hours}:${time.minutes}`)} reached`,
      };
    }
  }
  
  // Find next scheduled time
  const nextTime = sortedTimes.find(t => t.totalMinutes > currentMinutes) || sortedTimes[0];
  const nextDueAt = new Date();
  nextDueAt.setUTCHours(nextTime.hours, nextTime.minutes, 0, 0);
  
  if (nextTime.totalMinutes <= currentMinutes) {
    // Next time is tomorrow
    nextDueAt.setDate(nextDueAt.getDate() + 1);
  }
  
  return {
    isDue: false,
    reason: `Next scheduled time: ${normalizeTime(`${nextTime.hours}:${nextTime.minutes}`)}`,
    nextDueAt,
  };
}

/**
 * Check if a cron schedule is due.
 * 
 * @param cronExpression - The cron expression
 * @param timezone - The timezone (default: UTC)
 * @param lastPostAt - The last post timestamp
 * @returns IsDueResult
 */
export function isCronDue(
  cronExpression: string,
  timezone: string = 'UTC',
  lastPostAt: Date | null
): IsDueResult {
  const cron = parseCronExpression(cronExpression);
  const now = new Date();
  
  // Get current time components in the specified timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hour12: false,
  });
  
  const parts = formatter.formatToParts(now);
  const currentMinute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
  const currentHour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
  const currentDay = parseInt(parts.find(p => p.type === 'day')?.value || '1', 10);
  const currentMonth = parseInt(parts.find(p => p.type === 'month')?.value || '1', 10);
  
  // Map weekday name to number (0 = Sunday)
  const weekdayMap: Record<string, number> = {
    'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6,
  };
  const weekdayName = parts.find(p => p.type === 'weekday')?.value || 'Sun';
  const currentWeekday = weekdayMap[weekdayName] ?? 0;
  
  // Check if all cron fields match
  const matches =
    cronFieldMatches(cron.minute, currentMinute) &&
    cronFieldMatches(cron.hour, currentHour) &&
    cronFieldMatches(cron.dayOfMonth, currentDay) &&
    cronFieldMatches(cron.month, currentMonth) &&
    cronFieldMatches(cron.dayOfWeek, currentWeekday);
  
  if (matches) {
    // Check if we already posted this minute
    if (lastPostAt) {
      const lastPostMinute = lastPostAt.getUTCMinutes();
      const lastPostHour = lastPostAt.getUTCHours();
      const timeDiff = now.getTime() - lastPostAt.getTime();
      
      // If posted within the last minute, skip
      if (timeDiff < 60 * 1000) {
        return {
          isDue: false,
          reason: 'Already posted this minute',
        };
      }
    }
    
    return {
      isDue: true,
      reason: `Cron schedule matched: ${cronExpression}`,
    };
  }
  
  return {
    isDue: false,
    reason: `Cron schedule not matched: ${cronExpression}`,
  };
}

/**
 * Check if a bot's schedule is due.
 * 
 * @param config - The schedule configuration
 * @param lastPostAt - The last post timestamp
 * @returns IsDueResult
 * 
 * Validates: Requirements 5.2
 */
export function isDue(
  config: ScheduleConfig,
  lastPostAt: Date | null
): IsDueResult {
  const timezone = config.timezone || 'UTC';
  
  switch (config.type) {
    case 'interval':
      if (!config.intervalMinutes) {
        return { isDue: false, reason: 'Missing interval configuration' };
      }
      return isIntervalDue(config.intervalMinutes, lastPostAt);
      
    case 'times':
      if (!config.times || config.times.length === 0) {
        return { isDue: false, reason: 'Missing times configuration' };
      }
      return isTimesDue(config.times, timezone, lastPostAt);
      
    case 'cron':
      if (!config.cronExpression) {
        return { isDue: false, reason: 'Missing cron expression' };
      }
      return isCronDue(config.cronExpression, timezone, lastPostAt);
      
    default:
      return { isDue: false, reason: `Unknown schedule type: ${(config as any).type}` };
  }
}

// ============================================
// CONTENT AVAILABILITY
// ============================================

/**
 * Check if a bot has unprocessed content available.
 * 
 * @param botId - The bot ID
 * @returns True if unprocessed content exists
 * 
 * Validates: Requirements 5.5
 */
export async function hasUnprocessedContent(botId: string): Promise<boolean> {
  // Get all content sources for the bot
  const sources = await db.query.botContentSources.findMany({
    where: { AND: [{ botId: botId }, { isActive: true }] },
    columns: { id: true },
  });
  
  if (sources.length === 0) {
    return false;
  }
  
  // Check if any source has unprocessed content
  for (const source of sources) {
    const unprocessedItem = await db.query.botContentItems.findFirst({
      where: { AND: [{ sourceId: source.id }, { isProcessed: false }] },
      columns: { id: true },
    });
    
    if (unprocessedItem) {
      return true;
    }
  }
  
  return false;
}

/**
 * Get the next unprocessed content item for a bot.
 * 
 * @param botId - The bot ID
 * @returns The next content item or null
 */
export async function getNextUnprocessedContent(botId: string): Promise<{
  id: string;
  sourceId: string;
  title: string;
  content: string | null;
  url: string;
  publishedAt: Date;
} | null> {
  // Get all content sources for the bot
  const sources = await db.query.botContentSources.findMany({
    where: { AND: [{ botId: botId }, { isActive: true }] },
    columns: { id: true },
  });
  
  if (sources.length === 0) {
    return null;
  }
  
  // Find the oldest unprocessed item across all sources
  let oldestItem: typeof botContentItems.$inferSelect | null = null;
  
  for (const source of sources) {
    const item = await db.query.botContentItems.findFirst({
      where: { AND: [{ sourceId: source.id }, { isProcessed: false }] },
      orderBy: (items, { asc }) => [asc(items.publishedAt)],
    });
    
    if (item && (!oldestItem || item.publishedAt < oldestItem.publishedAt)) {
      oldestItem = item;
    }
  }
  
  if (!oldestItem) {
    return null;
  }
  
  return {
    id: oldestItem.id,
    sourceId: oldestItem.sourceId,
    title: oldestItem.title,
    content: oldestItem.content,
    url: oldestItem.url,
    publishedAt: oldestItem.publishedAt,
  };
}

// ============================================
// PROCESS SCHEDULED POSTS
// ============================================

/**
 * Process scheduled posts for all active bots.
 * Checks each bot's schedule, rate limits, and content availability.
 * Bots without content sources can still post based on their personality.
 * 
 * @returns Processing result with statistics
 * 
 * Validates: Requirements 5.2, 5.4, 5.5
 */
export async function processScheduledPosts(): Promise<ProcessScheduledPostsResult> {
  const result: ProcessScheduledPostsResult = {
    processed: 0,
    skipped: 0,
    errors: [],
    details: [],
  };
  
  // Get all active bots with schedules
  const activeBots = await db.query.bots.findMany({
    where: { AND: [{ isActive: true }, { isSuspended: false }] },
  });
  
  for (const bot of activeBots) {
    try {
      // Parse schedule config
      const scheduleConfig = parseScheduleConfig(bot.scheduleConfig);
      
      if (!scheduleConfig) {
        result.details.push({
          botId: bot.id,
          status: 'skipped_not_due',
          message: 'No valid schedule configuration',
        });
        result.skipped++;
        continue;
      }
      
      // Check if schedule is due
      const dueResult = isDue(scheduleConfig, bot.lastPostAt);
      
      if (!dueResult.isDue) {
        result.details.push({
          botId: bot.id,
          status: 'skipped_not_due',
          message: dueResult.reason,
        });
        result.skipped++;
        continue;
      }
      
      // Check rate limits
      const rateLimitResult = await canPost(bot.id);
      
      if (!rateLimitResult.allowed) {
        result.details.push({
          botId: bot.id,
          status: 'skipped_rate_limit',
          message: rateLimitResult.reason,
        });
        result.skipped++;
        continue;
      }
      
      // Check if bot has content sources
      const hasContentSources = await hasUnprocessedContent(bot.id).catch(() => false);
      
      // If bot has content sources, fetch fresh content and check availability
      if (hasContentSources || await botHasActiveSources(bot.id)) {
        // Fetch fresh content from sources before checking availability
        await fetchAllSourcesForBot(bot.id, { maxItems: 20, timeout: 15000 });
        
        // Check for unprocessed content (Requirement 5.5)
        const hasContent = await hasUnprocessedContent(bot.id);
        
        if (!hasContent) {
          result.details.push({
            botId: bot.id,
            status: 'skipped_no_content',
            message: 'No unprocessed content available',
          });
          result.skipped++;
          continue;
        }
        
        // Get the next content item
        const contentItem = await getNextUnprocessedContent(bot.id);
        
        if (!contentItem) {
          result.details.push({
            botId: bot.id,
            status: 'skipped_no_content',
            message: 'Failed to retrieve content item',
          });
          result.skipped++;
          continue;
        }
        
        // Trigger post creation with the content item
        const postResult = await triggerPost(bot.id, {
          sourceContentId: contentItem.id,
        });
        
        if (postResult.success) {
          result.details.push({
            botId: bot.id,
            status: 'posted',
            message: `Posted: ${contentItem.title.substring(0, 50)}...`,
          });
          result.processed++;
        } else {
          result.details.push({
            botId: bot.id,
            status: 'error',
            message: postResult.error || 'Failed to create post',
          });
          result.errors.push(`Bot ${bot.id}: ${postResult.error}`);
        }
      } else {
        // Bot has no content sources - generate original post based on personality
        const postResult = await triggerPost(bot.id, {});
        
        if (postResult.success) {
          result.details.push({
            botId: bot.id,
            status: 'posted',
            message: 'Posted original content',
          });
          result.processed++;
        } else {
          result.details.push({
            botId: bot.id,
            status: 'error',
            message: postResult.error || 'Failed to create post',
          });
          result.errors.push(`Bot ${bot.id}: ${postResult.error}`);
        }
      }
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      result.errors.push(`Bot ${bot.id}: ${errorMessage}`);
      result.details.push({
        botId: bot.id,
        status: 'error',
        message: errorMessage,
      });
    }
  }
  
  return result;
}

/**
 * Check if a bot has any active content sources.
 * 
 * @param botId - The bot ID
 * @returns True if bot has active sources
 */
async function botHasActiveSources(botId: string): Promise<boolean> {
  const sources = await db.query.botContentSources.findMany({
    where: { AND: [{ botId: botId }, { isActive: true }] },
    columns: { id: true },
  });
  
  return sources.length > 0;
}

/**
 * Get the schedule configuration for a bot.
 * 
 * @param botId - The bot ID
 * @returns The schedule configuration or null
 */
export async function getBotSchedule(botId: string): Promise<ScheduleConfig | null> {
  const bot = await db.query.bots.findFirst({
    where: { id: botId },
    columns: { scheduleConfig: true },
  });
  
  if (!bot) {
    return null;
  }
  
  return parseScheduleConfig(bot.scheduleConfig);
}

/**
 * Update the schedule configuration for a bot.
 * 
 * @param botId - The bot ID
 * @param config - The new schedule configuration
 * @throws Error if configuration is invalid
 */
export async function updateBotSchedule(
  botId: string,
  config: ScheduleConfig
): Promise<void> {
  const validation = validateScheduleConfig(config);
  
  if (!validation.valid) {
    throw new Error(`Invalid schedule configuration: ${validation.errors.join(', ')}`);
  }
  
  await db
    .update(bots)
    .set({
      scheduleConfig: serializeScheduleConfig(config),
      updatedAt: new Date(),
    })
    .where(eq(bots.id, botId));
}

/**
 * Remove the schedule configuration for a bot.
 * 
 * @param botId - The bot ID
 */
export async function removeBotSchedule(botId: string): Promise<void> {
  await db
    .update(bots)
    .set({
      scheduleConfig: null,
      updatedAt: new Date(),
    })
    .where(eq(bots.id, botId));
}
