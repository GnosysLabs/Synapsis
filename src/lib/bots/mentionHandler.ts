/**
 * Mention Handler Module
 * 
 * Detects mentions of bots in posts and manages mention responses.
 * Processes mentions in chronological order and respects reply rate limits.
 * 
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 */

import { db, bots, botMentions, posts, users } from '@/db';
import { eq, and, desc, asc, isNull } from 'drizzle-orm';
import { ContentGenerator, type Bot as GeneratorBot, type Post as GeneratorPost } from './contentGenerator';
import { canReply, recordReply } from './rateLimiter';
import { decryptApiKey } from './encryption';

// ============================================
// TYPES
// ============================================

/**
 * Mention data structure.
 */
export interface Mention {
  id: string;
  botId: string;
  postId: string;
  authorId: string;
  content: string;
  isProcessed: boolean;
  processedAt: Date | null;
  responsePostId: string | null;
  isRemote: boolean;
  remoteActorUrl: string | null;
  createdAt: Date;
}

/**
 * Post data with author information.
 */
export interface PostWithAuthor {
  id: string;
  userId: string;
  content: string;
  replyToId: string | null;
  createdAt: Date;
  author: {
    id: string;
    handle: string;
    displayName: string | null;
  };
}

/**
 * Mention detection result.
 */
export interface MentionDetectionResult {
  detected: boolean;
  mentions: Mention[];
}

/**
 * Mention response result.
 */
export interface MentionResponseResult {
  success: boolean;
  responsePostId?: string;
  error?: string;
}

/**
 * Error thrown by mention handler operations.
 */
export class MentionHandlerError extends Error {
  constructor(
    message: string,
    public code: MentionHandlerErrorCode,
    public cause?: Error
  ) {
    super(message);
    this.name = 'MentionHandlerError';
  }
}

export type MentionHandlerErrorCode =
  | 'BOT_NOT_FOUND'
  | 'MENTION_NOT_FOUND'
  | 'POST_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'GENERATION_FAILED'
  | 'DATABASE_ERROR';

// ============================================
// MENTION DETECTION
// ============================================

/**
 * Detect mentions of a bot in posts.
 * Scans posts for the bot's handle and creates mention records.
 * 
 * @param botId - The ID of the bot to check for mentions
 * @returns Detection result with found mentions
 * 
 * Validates: Requirements 7.1, 7.2
 */
export async function detectMentions(botId: string): Promise<MentionDetectionResult> {
  try {
    // Get the bot's handle
    const bot = await db.query.bots.findFirst({
      where: eq(bots.id, botId),
      with: {
        user: {
          columns: { handle: true },
        },
      },
      columns: { id: true },
    });

    if (!bot) {
      throw new MentionHandlerError(
        `Bot not found: ${botId}`,
        'BOT_NOT_FOUND'
      );
    }

    // Get existing mention post IDs to avoid duplicates
    const existingMentions = await db.query.botMentions.findMany({
      where: eq(botMentions.botId, botId),
      columns: { postId: true },
    });

    const existingPostIds = new Set(existingMentions.map(m => m.postId));

    // Find posts that mention the bot's handle
    // Note: In a production system, this would be more efficient with full-text search
    // or a dedicated mentions table updated on post creation
    const mentionPattern = `@${bot.user.handle}`;

    // Get recent posts (last 24 hours) that might contain mentions
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    const recentPosts = await db.query.posts.findMany({
      where: and(
        eq(posts.isRemoved, false)
      ),
      with: {
        author: {
          columns: {
            id: true,
            handle: true,
            displayName: true,
          },
        },
      },
      orderBy: [desc(posts.createdAt)],
      limit: 1000, // Reasonable limit for scanning
    });

    // Filter posts that mention the bot and aren't already tracked
    const newMentionPosts = recentPosts.filter(post =>
      post.content.includes(mentionPattern) &&
      !existingPostIds.has(post.id)
    );

    // Create mention records
    const newMentions: Mention[] = [];

    for (const post of newMentionPosts) {
      const [mention] = await db.insert(botMentions).values({
        botId,
        postId: post.id,
        authorId: post.userId,
        content: post.content,
        isProcessed: false,
        isRemote: false, // Local mentions for now
      }).returning();

      newMentions.push({
        id: mention.id,
        botId: mention.botId,
        postId: mention.postId,
        authorId: mention.authorId,
        content: mention.content,
        isProcessed: mention.isProcessed,
        processedAt: mention.processedAt,
        responsePostId: mention.responsePostId,
        isRemote: mention.isRemote,
        remoteActorUrl: mention.remoteActorUrl,
        createdAt: mention.createdAt,
      });
    }

    return {
      detected: newMentions.length > 0,
      mentions: newMentions,
    };
  } catch (error) {
    if (error instanceof MentionHandlerError) {
      throw error;
    }

    throw new MentionHandlerError(
      `Failed to detect mentions: ${error instanceof Error ? error.message : String(error)}`,
      'DATABASE_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Get unprocessed mentions for a bot in chronological order.
 * 
 * @param botId - The ID of the bot
 * @returns Array of unprocessed mentions, oldest first
 * 
 * Validates: Requirements 7.5
 */
export async function getUnprocessedMentions(botId: string): Promise<Mention[]> {
  try {
    const mentions = await db.query.botMentions.findMany({
      where: and(
        eq(botMentions.botId, botId),
        eq(botMentions.isProcessed, false)
      ),
      orderBy: [asc(botMentions.createdAt)], // Chronological order (oldest first)
    });

    return mentions.map(m => ({
      id: m.id,
      botId: m.botId,
      postId: m.postId,
      authorId: m.authorId,
      content: m.content,
      isProcessed: m.isProcessed,
      processedAt: m.processedAt,
      responsePostId: m.responsePostId,
      isRemote: m.isRemote,
      remoteActorUrl: m.remoteActorUrl,
      createdAt: m.createdAt,
    }));
  } catch (error) {
    throw new MentionHandlerError(
      `Failed to get unprocessed mentions: ${error instanceof Error ? error.message : String(error)}`,
      'DATABASE_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Get all mentions for a bot (processed and unprocessed).
 * 
 * @param botId - The ID of the bot
 * @returns Array of all mentions, newest first
 */
export async function getAllMentions(botId: string): Promise<Mention[]> {
  try {
    const mentions = await db.query.botMentions.findMany({
      where: eq(botMentions.botId, botId),
      orderBy: [desc(botMentions.createdAt)],
    });

    return mentions.map(m => ({
      id: m.id,
      botId: m.botId,
      postId: m.postId,
      authorId: m.authorId,
      content: m.content,
      isProcessed: m.isProcessed,
      processedAt: m.processedAt,
      responsePostId: m.responsePostId,
      isRemote: m.isRemote,
      remoteActorUrl: m.remoteActorUrl,
      createdAt: m.createdAt,
    }));
  } catch (error) {
    throw new MentionHandlerError(
      `Failed to get mentions: ${error instanceof Error ? error.message : String(error)}`,
      'DATABASE_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}

// ============================================
// CONVERSATION CONTEXT
// ============================================

/**
 * Get conversation context for a mention.
 * Retrieves the thread of posts leading up to the mention.
 * 
 * @param postId - The ID of the post containing the mention
 * @param maxDepth - Maximum number of parent posts to retrieve
 * @returns Array of posts in the conversation thread
 * 
 * Validates: Requirements 7.4
 */
export async function getConversationContext(
  postId: string,
  maxDepth: number = 5
): Promise<GeneratorPost[]> {
  try {
    const context: GeneratorPost[] = [];
    let currentPostId: string | null = postId;
    let depth = 0;

    while (currentPostId && depth < maxDepth) {
      const post: any = await db.query.posts.findFirst({
        where: eq(posts.id, currentPostId),
        with: {
          author: {
            columns: {
              handle: true,
              displayName: true,
            },
          },
        },
      });

      if (!post) break;

      // Add to context (we'll reverse later to get chronological order)
      context.push({
        id: post.id,
        userId: post.userId,
        content: post.content,
        createdAt: post.createdAt,
        author: {
          handle: post.author.handle,
          displayName: post.author.displayName,
        },
      });

      // Move to parent post
      currentPostId = post.replyToId;
      depth++;
    }

    // Reverse to get chronological order (oldest first)
    return context.reverse();
  } catch (error) {
    throw new MentionHandlerError(
      `Failed to get conversation context: ${error instanceof Error ? error.message : String(error)}`,
      'DATABASE_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}

// ============================================
// MENTION RESPONSE
// ============================================

/**
 * Process a mention and generate a response.
 * Checks rate limits, generates reply using LLM, and creates response post.
 * 
 * @param mentionId - The ID of the mention to process
 * @returns Response result with post ID or error
 * 
 * Validates: Requirements 7.3, 7.4, 7.6
 */
export async function processMention(mentionId: string): Promise<MentionResponseResult> {
  try {
    // Get the mention
    const mention = await db.query.botMentions.findFirst({
      where: eq(botMentions.id, mentionId),
    });

    if (!mention) {
      throw new MentionHandlerError(
        `Mention not found: ${mentionId}`,
        'MENTION_NOT_FOUND'
      );
    }

    // Check if already processed
    if (mention.isProcessed) {
      return {
        success: true,
        responsePostId: mention.responsePostId || undefined,
      };
    }

    // Check rate limits (Requirement 7.6)
    const rateLimitCheck = await canReply(mention.botId);
    if (!rateLimitCheck.allowed) {
      throw new MentionHandlerError(
        rateLimitCheck.reason || 'Rate limit exceeded',
        'RATE_LIMITED'
      );
    }

    // Get the bot
    const bot = await db.query.bots.findFirst({
      where: eq(bots.id, mention.botId),
      with: {
        user: {
          columns: {
            id: true,
            handle: true,
          },
        },
      },
    });

    if (!bot) {
      throw new MentionHandlerError(
        `Bot not found: ${mention.botId}`,
        'BOT_NOT_FOUND'
      );
    }

    // Get the mentioning post with author info
    const mentionPost = await db.query.posts.findFirst({
      where: eq(posts.id, mention.postId),
      with: {
        author: {
          columns: {
            handle: true,
            displayName: true,
          },
        },
      },
    });

    if (!mentionPost) {
      throw new MentionHandlerError(
        `Post not found: ${mention.postId}`,
        'POST_NOT_FOUND'
      );
    }

    // Get conversation context (Requirement 7.4)
    const conversationContext = await getConversationContext(mention.postId);

    // Remove the mention post itself from context (it will be passed separately)
    const contextWithoutMention = conversationContext.filter(p => p.id !== mention.postId);

    // Prepare bot for content generator
    const generatorBot: GeneratorBot = {
      id: bot.id,
      name: bot.name,
      handle: bot.user.handle,
      personalityConfig: JSON.parse(bot.personalityConfig),
      llmProvider: bot.llmProvider as any,
      llmModel: bot.llmModel,
      llmEndpoint: bot.llmEndpoint,
      llmApiKeyEncrypted: bot.llmApiKeyEncrypted,
    };

    // Prepare mention post for generator
    const generatorMentionPost: GeneratorPost = {
      id: mentionPost.id,
      userId: mentionPost.userId,
      content: mentionPost.content,
      createdAt: mentionPost.createdAt,
      author: {
        handle: mentionPost.author.handle,
        displayName: mentionPost.author.displayName,
      },
    };

    // Generate reply (Requirement 7.3)
    const generator = new ContentGenerator(generatorBot);
    const generatedReply = await generator.generateReply(
      generatorMentionPost,
      contextWithoutMention
    );

    // Create response post
    const [responsePost] = await db.insert(posts).values({
      userId: bot.user.id, // Bot posts as its associated user
      content: generatedReply.text,
      replyToId: mention.postId,
    }).returning();

    // Mark mention as processed
    await db.update(botMentions)
      .set({
        isProcessed: true,
        processedAt: new Date(),
        responsePostId: responsePost.id,
      })
      .where(eq(botMentions.id, mentionId));

    // Record reply for rate limiting
    await recordReply(mention.botId);

    return {
      success: true,
      responsePostId: responsePost.id,
    };
  } catch (error) {
    if (error instanceof MentionHandlerError) {
      return {
        success: false,
        error: error.message,
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Process all unprocessed mentions for a bot in chronological order.
 * Stops if rate limit is reached.
 * 
 * @param botId - The ID of the bot
 * @returns Array of response results
 * 
 * Validates: Requirements 7.5, 7.6
 */
export async function processAllMentions(botId: string): Promise<MentionResponseResult[]> {
  const mentions = await getUnprocessedMentions(botId);
  const results: MentionResponseResult[] = [];

  for (const mention of mentions) {
    // Check rate limit before processing each mention
    const rateLimitCheck = await canReply(botId);
    if (!rateLimitCheck.allowed) {
      // Stop processing if rate limited
      results.push({
        success: false,
        error: rateLimitCheck.reason,
      });
      break;
    }

    const result = await processMention(mention.id);
    results.push(result);

    // Stop if processing failed
    if (!result.success) {
      break;
    }
  }

  return results;
}

// ============================================
// MENTION STORAGE
// ============================================

/**
 * Store a detected mention in the database.
 * Used when mentions are detected from external sources (e.g., swarm nodes).
 * 
 * @param data - Mention data to store
 * @returns Created mention
 * 
 * Validates: Requirements 7.1, 7.2
 */
export async function storeMention(data: {
  botId: string;
  postId: string;
  authorId: string;
  content: string;
  isRemote?: boolean;
  remoteActorUrl?: string;
}): Promise<Mention> {
  try {
    const [mention] = await db.insert(botMentions).values({
      botId: data.botId,
      postId: data.postId,
      authorId: data.authorId,
      content: data.content,
      isProcessed: false,
      isRemote: data.isRemote || false,
      remoteActorUrl: data.remoteActorUrl || null,
    }).returning();

    return {
      id: mention.id,
      botId: mention.botId,
      postId: mention.postId,
      authorId: mention.authorId,
      content: mention.content,
      isProcessed: mention.isProcessed,
      processedAt: mention.processedAt,
      responsePostId: mention.responsePostId,
      isRemote: mention.isRemote,
      remoteActorUrl: mention.remoteActorUrl,
      createdAt: mention.createdAt,
    };
  } catch (error) {
    throw new MentionHandlerError(
      `Failed to store mention: ${error instanceof Error ? error.message : String(error)}`,
      'DATABASE_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Get a mention by ID.
 * 
 * @param mentionId - The ID of the mention
 * @returns Mention data or null if not found
 */
export async function getMentionById(mentionId: string): Promise<Mention | null> {
  try {
    const mention = await db.query.botMentions.findFirst({
      where: eq(botMentions.id, mentionId),
    });

    if (!mention) {
      return null;
    }

    return {
      id: mention.id,
      botId: mention.botId,
      postId: mention.postId,
      authorId: mention.authorId,
      content: mention.content,
      isProcessed: mention.isProcessed,
      processedAt: mention.processedAt,
      responsePostId: mention.responsePostId,
      isRemote: mention.isRemote,
      remoteActorUrl: mention.remoteActorUrl,
      createdAt: mention.createdAt,
    };
  } catch (error) {
    throw new MentionHandlerError(
      `Failed to get mention: ${error instanceof Error ? error.message : String(error)}`,
      'DATABASE_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}
