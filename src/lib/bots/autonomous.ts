/**
 * Autonomous Posting Module
 * 
 * Implements autonomous posting logic for bots. When autonomous mode is enabled,
 * bots post based on their schedule configuration. Content sources are optional -
 * bots without sources generate original posts based on their personality.
 * 
 * Requirements: 6.1, 6.2, 6.3, 6.5
 */

import { db, botContentItems, bots } from '@/db';
import { eq, and } from 'drizzle-orm';
import { ContentGenerator, type Bot as ContentGeneratorBot, type ContentItem } from './contentGenerator';
import { canPost } from './rateLimiter';
import { decryptApiKey, deserializeEncryptedData, type LLMProvider } from './encryption';
import { parseScheduleConfig, isDue } from './scheduler';
import { triggerPost } from './posting';

// ============================================
// TYPES
// ============================================

/**
 * Result of an autonomous posting evaluation.
 */
export interface AutonomousPostEvaluation {
  /** Whether the bot should post this content */
  shouldPost: boolean;
  /** Reason for the decision */
  reason: string;
  /** Content item that was evaluated */
  contentItem: ContentItem;
  /** Interest score from LLM evaluation */
  interestScore?: number;
}

/**
 * Result of an autonomous posting attempt.
 */
export interface AutonomousPostResult {
  /** Whether a post was created */
  posted: boolean;
  /** The post ID if created */
  postId?: string;
  /** Reason if not posted */
  reason?: string;
  /** Content item that was evaluated */
  contentItem?: ContentItem;
  /** Generated post text if posted */
  postText?: string;
}

/**
 * Options for autonomous posting.
 */
export interface AutonomousPostOptions {
  /** Maximum number of content items to evaluate */
  maxEvaluations?: number;
  /** Whether to skip rate limit checks (for testing) */
  skipRateLimitCheck?: boolean;
}

// ============================================
// ERROR CLASSES
// ============================================

/**
 * Base error class for autonomous posting operations.
 */
export class AutonomousPostError extends Error {
  constructor(
    message: string,
    public code: AutonomousPostErrorCode,
    public cause?: Error
  ) {
    super(message);
    this.name = 'AutonomousPostError';
  }
}

export type AutonomousPostErrorCode =
  | 'BOT_NOT_FOUND'
  | 'AUTONOMOUS_MODE_DISABLED'
  | 'NO_API_KEY'
  | 'RATE_LIMITED'
  | 'NO_CONTENT'
  | 'EVALUATION_FAILED'
  | 'POST_CREATION_FAILED';

// ============================================
// CONSTANTS
// ============================================

/**
 * Default maximum number of content items to evaluate per autonomous posting cycle.
 */
export const DEFAULT_MAX_EVALUATIONS = 10;

/**
 * Minimum interest score (0-100) for content to be considered interesting.
 * This is a heuristic based on the LLM's evaluation.
 */
export const MIN_INTEREST_SCORE = 60;

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Check if a bot has any active content sources configured.
 * 
 * @param botId - The ID of the bot
 * @returns True if bot has content sources
 */
async function hasContentSources(botId: string): Promise<boolean> {
  const bot = await db.query.bots.findFirst({
    where: eq(bots.id, botId),
    with: {
      contentSources: {
        where: (sources, { eq }) => eq(sources.isActive, true),
      },
    },
  });

  return !!(bot?.contentSources && bot.contentSources.length > 0);
}

/**
 * Get unprocessed content items for a bot.
 * Returns content items that haven't been processed yet, ordered by published date.
 * 
 * @param botId - The ID of the bot
 * @param limit - Maximum number of items to return
 * @returns Array of unprocessed content items
 */
async function getUnprocessedContentItems(
  botId: string,
  limit: number = DEFAULT_MAX_EVALUATIONS
): Promise<ContentItem[]> {
  // Get bot's content sources
  const bot = await db.query.bots.findFirst({
    where: eq(bots.id, botId),
    with: {
      contentSources: {
        where: (sources, { eq }) => eq(sources.isActive, true),
      },
    },
  });

  if (!bot || !bot.contentSources || bot.contentSources.length === 0) {
    return [];
  }

  const sourceIds = bot.contentSources.map(s => s.id);

  // Get unprocessed content items from these sources
  const items = await db.query.botContentItems.findMany({
    where: and(
      eq(botContentItems.isProcessed, false)
    ),
    orderBy: (items, { desc }) => [desc(items.publishedAt)],
    limit,
  });

  // Filter to only items from this bot's sources
  const filteredItems = items.filter(item => sourceIds.includes(item.sourceId));

  return filteredItems.map(item => ({
    id: item.id,
    sourceId: item.sourceId,
    title: item.title,
    content: item.content,
    url: item.url,
    publishedAt: item.publishedAt,
  }));
}

/**
 * Mark a content item as processed.
 * 
 * @param contentItemId - The ID of the content item
 * @param postId - Optional post ID if a post was created
 * @param interestScore - Optional interest score from evaluation
 * @param interestReason - Optional reason from evaluation
 */
async function markContentItemProcessed(
  contentItemId: string,
  postId?: string,
  interestScore?: number,
  interestReason?: string
): Promise<void> {
  await db
    .update(botContentItems)
    .set({
      isProcessed: true,
      processedAt: new Date(),
      postId: postId || null,
      interestScore: interestScore || null,
      interestReason: interestReason || null,
    })
    .where(eq(botContentItems.id, contentItemId));
}

/**
 * Convert a bot from database to ContentGenerator bot format.
 * 
 * @param bot - Bot from database
 * @returns Bot in ContentGenerator format
 */
function toContentGeneratorBot(bot: typeof bots.$inferSelect, handle: string): ContentGeneratorBot {
  return {
    id: bot.id,
    name: bot.name,
    handle: handle,
    personalityConfig: JSON.parse(bot.personalityConfig),
    llmProvider: bot.llmProvider as LLMProvider,
    llmModel: bot.llmModel,
    llmEndpoint: bot.llmEndpoint,
    llmApiKeyEncrypted: bot.llmApiKeyEncrypted,
  };
}

/**
 * Get decrypted API key for a bot.
 * 
 * @param bot - Bot from database
 * @returns Decrypted API key
 */
function getDecryptedApiKeyForBot(bot: typeof bots.$inferSelect): string {
  const encryptedData = deserializeEncryptedData(bot.llmApiKeyEncrypted);
  return decryptApiKey(encryptedData);
}

/**
 * Calculate a numeric interest score from the evaluation result.
 * This is a heuristic to convert the boolean + reason into a score.
 * 
 * @param interesting - Whether the content is interesting
 * @param reason - The reason for the decision
 * @returns Interest score (0-100)
 */
export function calculateInterestScore(interesting: boolean, reason: string): number {
  if (!interesting) {
    return 0;
  }

  // Base score for interesting content
  let score = 70;

  // Boost score based on positive keywords in reason
  const positiveKeywords = [
    'very', 'highly', 'extremely', 'excellent', 'perfect',
    'important', 'significant', 'valuable', 'relevant', 'timely'
  ];

  const lowerReason = reason.toLowerCase();
  for (const keyword of positiveKeywords) {
    if (lowerReason.includes(keyword)) {
      score += 5;
    }
  }

  // Cap at 100
  return Math.min(100, score);
}

// ============================================
// AUTONOMOUS POSTING FUNCTIONS
// ============================================

/**
 * Evaluate whether a bot should post content autonomously.
 * Uses the bot's LLM to evaluate content interest.
 * 
 * @param botId - The ID of the bot
 * @param contentItem - The content item to evaluate
 * @returns Evaluation result
 * 
 * Validates: Requirements 6.1, 6.2
 */
export async function evaluateContentForPosting(
  botId: string,
  contentItem: ContentItem
): Promise<AutonomousPostEvaluation> {
  // Get bot with user relation
  const dbBot = await db.query.bots.findFirst({
    where: eq(bots.id, botId),
    with: { user: true },
  });

  if (!dbBot) {
    throw new AutonomousPostError(
      `Bot not found: ${botId}`,
      'BOT_NOT_FOUND'
    );
  }

  // Check if autonomous mode is enabled
  if (!dbBot.autonomousMode) {
    return {
      shouldPost: false,
      reason: 'Autonomous mode is disabled for this bot',
      contentItem,
    };
  }

  // Check if bot has API key
  try {
    const apiKey = getDecryptedApiKeyForBot(dbBot);
    if (!apiKey || apiKey === '__REMOVED__') {
      throw new AutonomousPostError(
        'Bot does not have a valid API key configured',
        'NO_API_KEY'
      );
    }
  } catch (error) {
    throw new AutonomousPostError(
      'Failed to decrypt bot API key',
      'NO_API_KEY',
      error instanceof Error ? error : undefined
    );
  }

  // Create content generator
  const contentGeneratorBot = toContentGeneratorBot(dbBot, dbBot.user.handle);
  const generator = new ContentGenerator(contentGeneratorBot);

  try {
    // Evaluate content interest
    const evaluation = await generator.evaluateContentInterest(contentItem);

    // Calculate numeric interest score
    const interestScore = calculateInterestScore(
      evaluation.interesting,
      evaluation.reason
    );

    return {
      shouldPost: evaluation.interesting && interestScore >= MIN_INTEREST_SCORE,
      reason: evaluation.reason,
      contentItem,
      interestScore,
    };
  } catch (error) {
    throw new AutonomousPostError(
      `Failed to evaluate content interest: ${error instanceof Error ? error.message : String(error)}`,
      'EVALUATION_FAILED',
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Attempt to create an autonomous post for a bot.
 * Checks schedule timing, then either uses content sources or generates original posts.
 * 
 * This is the main entry point for autonomous posting.
 * 
 * @param botId - The ID of the bot
 * @param options - Optional configuration
 * @returns Result of the posting attempt
 * 
 * Validates: Requirements 6.1, 6.2, 6.3, 6.5
 */
export async function attemptAutonomousPost(
  botId: string,
  options: AutonomousPostOptions = {}
): Promise<AutonomousPostResult> {
  const {
    maxEvaluations = DEFAULT_MAX_EVALUATIONS,
    skipRateLimitCheck = false,
  } = options;

  // Get bot with schedule config
  const dbBot = await db.query.bots.findFirst({
    where: eq(bots.id, botId),
    with: { user: true },
  });

  if (!dbBot) {
    throw new AutonomousPostError(
      `Bot not found: ${botId}`,
      'BOT_NOT_FOUND'
    );
  }

  // Check if autonomous mode is enabled (Requirement 6.5)
  if (!dbBot.autonomousMode) {
    return {
      posted: false,
      reason: 'Autonomous mode is disabled',
    };
  }

  // Check if bot is active and not suspended
  if (!dbBot.isActive) {
    return {
      posted: false,
      reason: 'Bot is not active',
    };
  }

  if (dbBot.isSuspended) {
    return {
      posted: false,
      reason: 'Bot is suspended',
    };
  }

  // Check schedule timing (if configured)
  const scheduleConfig = parseScheduleConfig(dbBot.scheduleConfig);
  if (scheduleConfig) {
    const dueResult = isDue(scheduleConfig, dbBot.lastPostAt);
    if (!dueResult.isDue) {
      return {
        posted: false,
        reason: dueResult.reason || 'Not scheduled to post yet',
      };
    }
  }

  // Check rate limits (Requirement 6.3)
  if (!skipRateLimitCheck) {
    const rateLimitCheck = await canPost(botId);
    if (!rateLimitCheck.allowed) {
      return {
        posted: false,
        reason: rateLimitCheck.reason || 'Rate limit exceeded',
      };
    }
  }

  // Check if bot has API key
  try {
    const apiKey = getDecryptedApiKeyForBot(dbBot);
    if (!apiKey || apiKey === '__REMOVED__') {
      throw new AutonomousPostError(
        'Bot does not have a valid API key configured',
        'NO_API_KEY'
      );
    }
  } catch (error) {
    if (error instanceof AutonomousPostError) throw error;
    throw new AutonomousPostError(
      'Failed to decrypt bot API key',
      'NO_API_KEY',
      error instanceof Error ? error : undefined
    );
  }

  // Check if bot has content sources
  const hasSourcesConfigured = await hasContentSources(botId);

  if (hasSourcesConfigured) {
    // Bot has content sources - try content-based posting first
    const contentItems = await getUnprocessedContentItems(botId, maxEvaluations);

    if (contentItems.length > 0) {
      // Evaluate content items until we find one worth posting
      for (const contentItem of contentItems) {
        try {
          const evaluation = await evaluateContentForPosting(botId, contentItem);

          // Mark as processed regardless of decision
          await markContentItemProcessed(
            contentItem.id,
            undefined,
            evaluation.interestScore,
            evaluation.reason
          );

          if (evaluation.shouldPost) {
            // Use triggerPost to actually create the post in the database
            const postResult = await triggerPost(botId, {
              sourceContentId: contentItem.id,
              skipRateLimitCheck, // Already checked above
            });

            if (postResult.success) {
              return {
                posted: true,
                postId: postResult.post?.id,
                postText: postResult.post?.content,
                contentItem,
              };
            } else {
              throw new AutonomousPostError(
                postResult.error || 'Failed to create post',
                postResult.errorCode as AutonomousPostErrorCode || 'POST_CREATION_FAILED'
              );
            }
          }
        } catch (error) {
          console.error(`Error evaluating content item ${contentItem.id}:`, error);
          await markContentItemProcessed(
            contentItem.id,
            undefined,
            0,
            `Evaluation failed: ${error instanceof Error ? error.message : String(error)}`
          );
          continue;
        }
      }
      // No interesting content found - fall through to generate original post
    }
  }

  // Generate original post based on personality (no content source needed)
  // Use triggerPost which handles database insertion, rate limiting, and federation
  const postResult = await triggerPost(botId, {
    skipRateLimitCheck, // Already checked above
  });

  if (postResult.success) {
    return {
      posted: true,
      postId: postResult.post?.id,
      postText: postResult.post?.content,
    };
  } else {
    throw new AutonomousPostError(
      postResult.error || 'Failed to create post',
      postResult.errorCode as AutonomousPostErrorCode || 'POST_CREATION_FAILED'
    );
  }
}

/**
 * Process autonomous posting for all active bots with autonomous mode enabled.
 * This would typically be called by a scheduled job.
 * 
 * @returns Array of results for each bot
 * 
 * Validates: Requirements 6.1, 6.5
 */
export async function processAllAutonomousBots(): Promise<Array<{
  botId: string;
  botHandle: string;
  result: AutonomousPostResult;
  error?: string;
}>> {
  // Get all active bots with autonomous mode enabled
  const autonomousBots = await db.query.bots.findMany({
    where: and(
      eq(bots.isActive, true),
      eq(bots.isSuspended, false),
      eq(bots.autonomousMode, true)
    ),
    with: { user: true },
  });

  const results = [];

  for (const bot of autonomousBots) {
    try {
      const result = await attemptAutonomousPost(bot.id);
      results.push({
        botId: bot.id,
        botHandle: bot.user.handle,
        result,
      });
    } catch (error) {
      results.push({
        botId: bot.id,
        botHandle: bot.user.handle,
        result: {
          posted: false,
          reason: 'Error during autonomous posting',
        },
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

/**
 * Check if a bot can post autonomously.
 * Validates all requirements for autonomous posting.
 * 
 * @param botId - The ID of the bot
 * @returns Object with canPost flag and reason if not allowed
 * 
 * Validates: Requirements 6.1, 6.3, 6.5
 */
export async function canPostAutonomously(botId: string): Promise<{
  canPost: boolean;
  reason?: string;
}> {
  // Get bot
  const bot = await db.query.bots.findFirst({
    where: eq(bots.id, botId),
  });
  
  if (!bot) {
    return {
      canPost: false,
      reason: 'Bot not found',
    };
  }

  // Check if autonomous mode is enabled (Requirement 6.5)
  if (!bot.autonomousMode) {
    return {
      canPost: false,
      reason: 'Autonomous mode is disabled',
    };
  }

  // Check if bot is active and not suspended
  if (!bot.isActive) {
    return {
      canPost: false,
      reason: 'Bot is not active',
    };
  }

  if (bot.isSuspended) {
    return {
      canPost: false,
      reason: 'Bot is suspended',
    };
  }

  // Check schedule timing (if configured)
  const scheduleConfig = parseScheduleConfig(bot.scheduleConfig);
  if (scheduleConfig) {
    const dueResult = isDue(scheduleConfig, bot.lastPostAt);
    if (!dueResult.isDue) {
      return {
        canPost: false,
        reason: dueResult.reason || 'Not scheduled to post yet',
      };
    }
  }

  // Check rate limits (Requirement 6.3)
  const rateLimitCheck = await canPost(botId);
  if (!rateLimitCheck.allowed) {
    return {
      canPost: false,
      reason: rateLimitCheck.reason,
    };
  }

  // Bots can always post - content sources are optional
  return {
    canPost: true,
  };
}

/**
 * Toggle autonomous mode for a bot.
 * 
 * @param botId - The ID of the bot
 * @param enabled - Whether to enable or disable autonomous mode
 * 
 * Validates: Requirements 6.5
 */
export async function toggleAutonomousMode(
  botId: string,
  enabled: boolean
): Promise<void> {
  await db
    .update(bots)
    .set({
      autonomousMode: enabled,
      updatedAt: new Date(),
    })
    .where(eq(bots.id, botId));
}

/**
 * Get autonomous posting statistics for a bot.
 * 
 * @param botId - The ID of the bot
 * @returns Statistics about autonomous posting
 */
export async function getAutonomousPostingStats(botId: string): Promise<{
  totalContentItems: number;
  processedItems: number;
  unprocessedItems: number;
  postsCreated: number;
  averageInterestScore: number;
}> {
  // Get bot's content sources
  const bot = await db.query.bots.findFirst({
    where: eq(bots.id, botId),
    with: {
      contentSources: true,
    },
  });

  if (!bot || !bot.contentSources) {
    return {
      totalContentItems: 0,
      processedItems: 0,
      unprocessedItems: 0,
      postsCreated: 0,
      averageInterestScore: 0,
    };
  }

  const sourceIds = bot.contentSources.map(s => s.id);

  // Get all content items for this bot's sources
  const allItems = await db.query.botContentItems.findMany({
    where: (items, { inArray }) => inArray(items.sourceId, sourceIds),
  });

  const processedItems = allItems.filter(item => item.isProcessed);
  const unprocessedItems = allItems.filter(item => !item.isProcessed);
  const postsCreated = allItems.filter(item => item.postId !== null);

  const interestScores = processedItems
    .map(item => item.interestScore)
    .filter((score): score is number => score !== null);

  const averageInterestScore = interestScores.length > 0
    ? interestScores.reduce((sum, score) => sum + score, 0) / interestScores.length
    : 0;

  return {
    totalContentItems: allItems.length,
    processedItems: processedItems.length,
    unprocessedItems: unprocessedItems.length,
    postsCreated: postsCreated.length,
    averageInterestScore: Math.round(averageInterestScore),
  };
}
