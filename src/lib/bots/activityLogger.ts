/**
 * Activity Logger Service
 * 
 * Records all bot actions for auditing and debugging.
 * Supports filtering by action type and date range.
 * 
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.6
 */

import { db, botActivityLogs } from '@/db';
import { eq, and, gte, lte, desc, inArray } from 'drizzle-orm';

// ============================================
// TYPES
// ============================================

export type ActionType =
  | 'post_created'
  | 'mention_response'
  | 'content_fetched'
  | 'llm_call'
  | 'error'
  | 'config_changed'
  | 'rate_limited';

export interface ActivityLogEntry {
  botId: string;
  action: ActionType;
  details: Record<string, unknown>;
  success: boolean;
  errorMessage?: string;
}

export interface ActivityLog {
  id: string;
  botId: string;
  action: string;
  details: Record<string, unknown>;
  success: boolean;
  errorMessage: string | null;
  createdAt: Date;
}

export interface LogQueryOptions {
  actionTypes?: ActionType[];
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

// ============================================
// LOGGING FUNCTIONS
// ============================================

/**
 * Log a bot action.
 * 
 * @param entry - Activity log entry
 * @returns Created log record
 * 
 * Validates: Requirements 8.1, 8.3, 8.4
 */
export async function log(entry: ActivityLogEntry): Promise<ActivityLog> {
  const [logRecord] = await db.insert(botActivityLogs).values({
    botId: entry.botId,
    action: entry.action,
    details: JSON.stringify(entry.details),
    success: entry.success,
    errorMessage: entry.errorMessage || null,
  }).returning();
  
  return {
    id: logRecord.id,
    botId: logRecord.botId,
    action: logRecord.action,
    details: JSON.parse(logRecord.details),
    success: logRecord.success,
    errorMessage: logRecord.errorMessage,
    createdAt: logRecord.createdAt,
  };
}

/**
 * Get logs for a bot with optional filtering.
 * Returns logs in reverse chronological order.
 * 
 * @param botId - The ID of the bot
 * @param options - Query options for filtering
 * @returns Array of activity logs
 * 
 * Validates: Requirements 8.2, 8.6
 */
export async function getLogsForBot(
  botId: string,
  options: LogQueryOptions = {}
): Promise<ActivityLog[]> {
  // Build query
  let query = db.query.botActivityLogs.findMany({
    where: {
      botId,
      ...(options.actionTypes?.length ? { action: { in: options.actionTypes } } : {}),
      ...(options.startDate || options.endDate ? {
        createdAt: {
          ...(options.startDate ? { gte: options.startDate } : {}),
          ...(options.endDate ? { lte: options.endDate } : {}),
        },
      } : {}),
    },
    orderBy: (botActivityLogs, { desc }) => [desc(botActivityLogs.createdAt)], // Reverse chronological
    limit: options.limit || 100,
    offset: options.offset || 0,
  });
  
  const logs = await query;
  
  return logs.map(log => ({
    id: log.id,
    botId: log.botId,
    action: log.action,
    details: JSON.parse(log.details),
    success: log.success,
    errorMessage: log.errorMessage,
    createdAt: log.createdAt,
  }));
}

/**
 * Get error logs for a bot.
 * 
 * @param botId - The ID of the bot
 * @param limit - Maximum number of logs to return
 * @returns Array of error logs
 * 
 * Validates: Requirements 8.6
 */
export async function getErrorLogs(
  botId: string,
  limit: number = 50
): Promise<ActivityLog[]> {
  const logs = await db.query.botActivityLogs.findMany({
    where: { AND: [{ botId: botId }, { success: false }] },
    orderBy: (botActivityLogs, { desc }) => [desc(botActivityLogs.createdAt)],
    limit,
  });
  
  return logs.map(log => ({
    id: log.id,
    botId: log.botId,
    action: log.action,
    details: JSON.parse(log.details),
    success: log.success,
    errorMessage: log.errorMessage,
    createdAt: log.createdAt,
  }));
}

// ============================================
// CONVENIENCE FUNCTIONS
// ============================================

/**
 * Log a successful post creation.
 */
export async function logPostCreated(
  botId: string,
  postId: string,
  contentSourceId?: string
): Promise<void> {
  await log({
    botId,
    action: 'post_created',
    details: { postId, contentSourceId },
    success: true,
  });
}

/**
 * Log a successful mention response.
 */
export async function logMentionResponse(
  botId: string,
  mentionId: string,
  responsePostId: string
): Promise<void> {
  await log({
    botId,
    action: 'mention_response',
    details: { mentionId, responsePostId },
    success: true,
  });
}

/**
 * Log content fetching.
 */
export async function logContentFetched(
  botId: string,
  sourceId: string,
  itemCount: number,
  success: boolean,
  error?: string
): Promise<void> {
  await log({
    botId,
    action: 'content_fetched',
    details: { sourceId, itemCount },
    success,
    errorMessage: error,
  });
}

/**
 * Log an LLM API call.
 */
export async function logLLMCall(
  botId: string,
  model: string,
  tokensUsed: number,
  success: boolean,
  error?: string
): Promise<void> {
  await log({
    botId,
    action: 'llm_call',
    details: { model, tokensUsed },
    success,
    errorMessage: error,
  });
}

/**
 * Log a configuration change.
 */
export async function logConfigChanged(
  botId: string,
  changes: Record<string, unknown>
): Promise<void> {
  await log({
    botId,
    action: 'config_changed',
    details: changes,
    success: true,
  });
}

/**
 * Log a rate limit violation.
 */
export async function logRateLimited(
  botId: string,
  limitType: string,
  reason: string
): Promise<void> {
  await log({
    botId,
    action: 'rate_limited',
    details: { limitType },
    success: false,
    errorMessage: reason,
  });
}

/**
 * Log a generic error.
 */
export async function logError(
  botId: string,
  action: ActionType,
  error: string,
  details: Record<string, unknown> = {}
): Promise<void> {
  await log({
    botId,
    action,
    details,
    success: false,
    errorMessage: error,
  });
}
