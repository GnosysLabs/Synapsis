/**
 * Bot Posting Module
 * 
 * Implements post creation logic for bots. Handles content selection,
 * LLM generation, validation, database insertion, and rate limiting.
 * 
 * Requirements: 5.4, 11.5, 11.6
 */

import { db, posts, users, bots, botContentItems, botActivityLogs, botContentSources } from '@/db';
import { eq, and, inArray } from 'drizzle-orm';
import { ContentGenerator, type Bot as ContentGeneratorBot, type ContentItem } from './contentGenerator';
import { canPost, recordPost } from './rateLimiter';
import { getBotById } from './botManager';
import { decryptApiKey, deserializeEncryptedData, type LLMProvider } from './encryption';
import { fetchRedditRichPreview } from '@/lib/media/redditPreview';
import type { LinkPreviewData } from '@/lib/media/linkPreview';
import { fetchGenericLinkPreview } from '@/lib/media/genericPreview';

// ============================================
// TYPES
// ============================================

/**
 * Options for triggering a post.
 */
export interface TriggerPostOptions {
  /** Specific content item ID to post about */
  sourceContentId?: string;
  /** Additional context for the post */
  context?: string;
  /** Whether to skip rate limit checks (for testing) */
  skipRateLimitCheck?: boolean;
  /** Whether to skip content validation */
  skipValidation?: boolean;
}

/**
 * Result of a post creation attempt.
 */
export interface PostCreationResult {
  /** Whether the post was created successfully */
  success: boolean;
  /** The created post if successful */
  post?: typeof posts.$inferSelect;
  /** Error message if failed */
  error?: string;
  /** Error code if failed */
  errorCode?: PostCreationErrorCode;
  /** Content item that was used */
  contentItem?: ContentItem;
}

/**
 * Post validation result.
 */
export interface PostValidationResult {
  /** Whether the post is valid */
  valid: boolean;
  /** Validation errors */
  errors: string[];
}

/**
 * Error codes for post creation failures.
 */
export type PostCreationErrorCode =
  | 'BOT_NOT_FOUND'
  | 'BOT_SUSPENDED'
  | 'BOT_INACTIVE'
  | 'NO_API_KEY'
  | 'RATE_LIMITED'
  | 'NO_CONTENT'
  | 'CONTENT_NOT_FOUND'
  | 'GENERATION_FAILED'
  | 'VALIDATION_FAILED'
  | 'DATABASE_ERROR'
  | 'FEDERATION_ERROR';

// ============================================
// CONSTANTS
// ============================================

/**
 * Maximum post length (matches platform limit).
 * Validates: Requirements 11.5
 */
export const POST_MAX_LENGTH = 600;

/**
 * Minimum post length.
 */
export const POST_MIN_LENGTH = 1;

/**
 * Maximum number of URLs allowed in a post.
 */
export const MAX_URLS_PER_POST = 5;

/**
 * Forbidden content patterns (basic content policy).
 */
const FORBIDDEN_PATTERNS = [
  /\b(spam|scam|phishing)\b/i,
  // Add more patterns as needed
];

// ============================================
// ERROR CLASSES
// ============================================

/**
 * Error thrown during post creation.
 */
export class PostCreationError extends Error {
  constructor(
    message: string,
    public code: PostCreationErrorCode,
    public cause?: Error
  ) {
    super(message);
    this.name = 'PostCreationError';
  }
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Convert a bot from database to ContentGenerator bot format.
 * 
 * @param bot - Bot from database
 * @returns Bot in ContentGenerator format
 */
function toContentGeneratorBot(bot: typeof bots.$inferSelect & { user: { handle: string } }): ContentGeneratorBot {
  if (!bot.user) {
    throw new Error(`Bot ${bot.id} is missing user relation`);
  }
  return {
    id: bot.id,
    name: bot.name,
    handle: bot.user.handle,
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
 * Get a content item by ID.
 * 
 * @param contentItemId - The content item ID
 * @returns Content item or null
 */
async function getContentItemById(contentItemId: string): Promise<ContentItem | null> {
  const item = await db.query.botContentItems.findFirst({
    where: eq(botContentItems.id, contentItemId),
  });

  if (!item) {
    return null;
  }

  return {
    id: item.id,
    sourceId: item.sourceId,
    externalId: item.externalId,
    title: item.title,
    content: item.content,
    url: item.url,
    publishedAt: item.publishedAt,
  };
}

/**
 * Get the next unprocessed content item for a bot.
 * Avoids selecting content that was already posted about (ever).
 * 
 * @param botId - The bot ID
 * @returns Content item or null
 */
async function getNextUnprocessedContentItem(botId: string): Promise<ContentItem | null> {
  // Get bot's content sources
  const bot = await db.query.bots.findFirst({
    where: eq(bots.id, botId),
    with: {
      contentSources: {
        where: (sources, { eq }) => eq(sources.isActive, true),
      },
      user: true,
    },
  });

  if (!bot || !bot.contentSources || bot.contentSources.length === 0) {
    return null;
  }

  const sourceIds = bot.contentSources.map(s => s.id);

  // Get ALL posts by this bot to avoid duplicates (no time limit)
  const allBotPosts = await db.query.posts.findMany({
    where: eq(posts.userId, bot.userId),
    columns: {
      linkPreviewUrl: true,
    },
  });

  // Build a set of all URLs this bot has ever posted about
  const postedUrls = new Set<string>();
  for (const post of allBotPosts) {
    if (post.linkPreviewUrl) {
      postedUrls.add(post.linkPreviewUrl.toLowerCase());
    }
  }

  // Get unprocessed content items from this bot's sources
  const items = await db.query.botContentItems.findMany({
    where: and(
      eq(botContentItems.isProcessed, false),
      inArray(botContentItems.sourceId, sourceIds)
    ),
    orderBy: (items, { asc }) => [asc(items.publishedAt)],
    limit: 100, // Get more items to have options after filtering
  });

  // Find the first item that hasn't been posted about
  for (const item of items) {
    const itemUrl = item.url?.toLowerCase() || '';
    
    // Skip if URL was ever used
    if (itemUrl && postedUrls.has(itemUrl)) {
      // Mark as processed since we'll never use it
      await db
        .update(botContentItems)
        .set({ isProcessed: true, processedAt: new Date() })
        .where(eq(botContentItems.id, item.id));
      continue;
    }

    return {
      id: item.id,
      sourceId: item.sourceId,
      externalId: item.externalId,
      title: item.title,
      content: item.content,
      url: item.url,
      publishedAt: item.publishedAt,
    };
  }

  // No suitable content found
  return null;
}

/**
 * Get the bot's previous posts for context.
 * Returns the content of the most recent posts to help avoid repetition.
 * 
 * @param botId - The bot ID
 * @param limit - Maximum number of posts to fetch (default: 40)
 * @returns Array of post content strings
 */
async function getBotPreviousPosts(botId: string, limit: number = 40): Promise<string[]> {
  // Get bot to find its user ID
  const bot = await db.query.bots.findFirst({
    where: eq(bots.id, botId),
  });

  if (!bot) {
    return [];
  }

  // Get the bot's recent posts
  const recentPosts = await db.query.posts.findMany({
    where: eq(posts.userId, bot.userId),
    orderBy: (posts, { desc }) => [desc(posts.createdAt)],
    limit,
    columns: {
      content: true,
    },
  });

  // Return just the content strings
  return recentPosts
    .map(p => p.content)
    .filter((content): content is string => !!content);
}

/**
 * Mark a content item as processed.
 * 
 * @param contentItemId - The content item ID
 * @param postId - The created post ID
 */
async function markContentItemProcessed(
  contentItemId: string,
  postId: string
): Promise<void> {
  await db
    .update(botContentItems)
    .set({
      isProcessed: true,
      processedAt: new Date(),
      postId,
    })
    .where(eq(botContentItems.id, contentItemId));
}

/**
 * Log a bot activity.
 * 
 * @param botId - The bot ID
 * @param action - The action type
 * @param details - Action details
 * @param success - Whether the action succeeded
 * @param errorMessage - Error message if failed
 */
async function logActivity(
  botId: string,
  action: string,
  details: Record<string, unknown>,
  success: boolean,
  errorMessage?: string
): Promise<void> {
  try {
    await db.insert(botActivityLogs).values({
      botId,
      action,
      details: JSON.stringify(details),
      success,
      errorMessage: errorMessage || null,
    });
  } catch (error) {
    // Don't throw on logging failure
    console.error('Failed to log bot activity:', error);
  }
}

// ============================================
// VALIDATION FUNCTIONS
// ============================================

/**
 * Validate post content against platform requirements.
 * 
 * @param content - The post content to validate
 * @returns Validation result
 * 
 * Validates: Requirements 11.5
 */
export function validatePostContent(content: string): PostValidationResult {
  const errors: string[] = [];

  // Check if content exists
  if (!content || typeof content !== 'string') {
    errors.push('Post content is required');
    return { valid: false, errors };
  }

  // Trim content
  const trimmed = content.trim();

  // Check minimum length
  if (trimmed.length < POST_MIN_LENGTH) {
    errors.push(`Post must be at least ${POST_MIN_LENGTH} character(s)`);
  }

  // Check maximum length (Requirement 11.5)
  if (trimmed.length > POST_MAX_LENGTH) {
    errors.push(`Post must not exceed ${POST_MAX_LENGTH} characters (got ${trimmed.length})`);
  }

  // Check for forbidden patterns
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(trimmed)) {
      errors.push('Post contains forbidden content');
      break;
    }
  }

  // Check URL count
  const urlMatches = trimmed.match(/https?:\/\/[^\s]+/g);
  if (urlMatches && urlMatches.length > MAX_URLS_PER_POST) {
    errors.push(`Post contains too many URLs (max ${MAX_URLS_PER_POST})`);
  }

  // Check for empty or whitespace-only content
  if (trimmed.length === 0) {
    errors.push('Post cannot be empty or whitespace-only');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Sanitize post content.
 * Removes potentially harmful content while preserving formatting.
 * 
 * @param content - The content to sanitize
 * @returns Sanitized content
 */
export function sanitizePostContent(content: string): string {
  if (!content) {
    return '';
  }

  // Trim whitespace
  let sanitized = content.trim();

  // Remove null bytes
  sanitized = sanitized.replace(/\0/g, '');

  // Normalize line breaks
  sanitized = sanitized.replace(/\r\n/g, '\n');

  // Remove excessive whitespace
  sanitized = sanitized.replace(/\n{3,}/g, '\n\n');

  // Truncate if too long (with smart truncation)
  if (sanitized.length > POST_MAX_LENGTH) {
    sanitized = truncatePostContent(sanitized, POST_MAX_LENGTH);
  }

  return sanitized;
}

/**
 * Truncate post content intelligently.
 * Tries to break at sentence or word boundaries.
 * 
 * @param content - The content to truncate
 * @param maxLength - Maximum length
 * @returns Truncated content
 */
function truncatePostContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }

  // Reserve space for ellipsis
  const targetLength = maxLength - 1;

  // Try to find a sentence boundary (., !, ?) within the last 100 chars
  const searchStart = Math.max(0, targetLength - 100);
  const searchText = content.slice(searchStart, targetLength);

  // Find last sentence end
  const sentenceMatch = searchText.match(/.*[.!?]/);
  if (sentenceMatch) {
    const sentenceEnd = searchStart + sentenceMatch[0].length;
    if (sentenceEnd > targetLength * 0.7) {
      return content.slice(0, sentenceEnd).trim();
    }
  }

  // Try to find a word boundary
  const lastSpace = content.lastIndexOf(' ', targetLength);
  if (lastSpace > targetLength * 0.7) {
    return content.slice(0, lastSpace).trim() + '…';
  }

  // Hard truncate
  return content.slice(0, targetLength).trim() + '…';
}

// ============================================
// POST CREATION FUNCTIONS
// ============================================

/**
 * Select content for posting.
 * Either uses the specified content ID or selects the next unprocessed item.
 * 
 * @param botId - The bot ID
 * @param sourceContentId - Optional specific content ID
 * @returns Content item or null
 * 
 * Validates: Requirements 5.4
 */
export async function selectContentForPosting(
  botId: string,
  sourceContentId?: string
): Promise<ContentItem | null> {
  if (sourceContentId) {
    // Use specific content item
    const item = await getContentItemById(sourceContentId);

    if (!item) {
      throw new PostCreationError(
        `Content item not found: ${sourceContentId}`,
        'CONTENT_NOT_FOUND'
      );
    }

    // Verify the content belongs to this bot's sources
    const bot = await db.query.bots.findFirst({
      where: eq(bots.id, botId),
      with: {
        contentSources: true,
        user: true,
      },
    });

    if (!bot || !bot.contentSources) {
      throw new PostCreationError(
        `Bot not found: ${botId}`,
        'BOT_NOT_FOUND'
      );
    }

    const sourceIds = bot.contentSources.map(s => s.id);
    if (!sourceIds.includes(item.sourceId)) {
      throw new PostCreationError(
        'Content item does not belong to this bot',
        'CONTENT_NOT_FOUND'
      );
    }

    return item;
  }

  // Select next unprocessed content
  return await getNextUnprocessedContentItem(botId);
}

/**
 * Generate post content using LLM.
 * 
 * @param bot - The bot (from database)
 * @param contentItem - Optional content item to post about
 * @param context - Optional additional context
 * @param previousPosts - Optional array of previous post contents for context
 * @returns Generated post text
 * 
 * Validates: Requirements 11.6
 */
export async function generatePostContent(
  bot: typeof bots.$inferSelect & { user: { handle: string } },
  contentItem?: ContentItem,
  context?: string,
  previousPosts?: string[]
): Promise<string> {
  // Check if bot has API key
  try {
    const apiKey = getDecryptedApiKeyForBot(bot);
    if (!apiKey || apiKey === '__REMOVED__') {
      throw new PostCreationError(
        'Bot does not have a valid API key configured',
        'NO_API_KEY'
      );
    }
  } catch (error) {
    throw new PostCreationError(
      'Failed to decrypt bot API key',
      'NO_API_KEY',
      error instanceof Error ? error : undefined
    );
  }

  // Create content generator
  const contentGeneratorBot = toContentGeneratorBot(bot);
  const generator = new ContentGenerator(contentGeneratorBot);

  try {
    // Generate post (Requirement 11.6)
    const generatedContent = await generator.generatePost(contentItem, context, previousPosts);

    // Log the generation
    await logActivity(
      bot.id,
      'llm_call',
      {
        type: 'post_generation',
        contentItemId: contentItem?.id,
        tokensUsed: generatedContent.tokensUsed,
        model: generatedContent.model,
        previousPostsCount: previousPosts?.length || 0,
      },
      true
    );

    return generatedContent.text;
  } catch (error) {
    // Log the error
    await logActivity(
      bot.id,
      'llm_call',
      {
        type: 'post_generation',
        contentItemId: contentItem?.id,
        error: error instanceof Error ? error.message : String(error),
      },
      false,
      error instanceof Error ? error.message : String(error)
    );

    throw new PostCreationError(
      `Failed to generate post content: ${error instanceof Error ? error.message : String(error)}`,
      'GENERATION_FAILED',
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Check if a URL is from Reddit.
 */
function isRedditUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith('reddit.com') || parsed.hostname === 'redd.it';
  } catch {
    return false;
  }
}

/**
 * Fetch link preview for Reddit URLs using their oEmbed API.
 * Reddit blocks regular scraping but provides oEmbed for embedding.
 */
async function fetchRedditPreview(url: string): Promise<LinkPreviewData | null> {
  return fetchRedditRichPreview(url);
}

/**
 * Fetch link preview metadata for a URL.
 * Uses site-specific handlers for sites that block scraping.
 * 
 * @param url - The URL to fetch preview for
 * @returns Link preview data or null
 */
async function fetchLinkPreview(url: string): Promise<LinkPreviewData | null> {
  // Use Reddit-specific handler
  if (isRedditUrl(url)) {
    return fetchRedditPreview(url);
  }

  // Generic OG tag scraping for other sites
  try {
    return await fetchGenericLinkPreview(url);
  } catch (error) {
    console.error('Failed to fetch link preview:', error);
    return null;
  }
}

function extractRedditPostId(contentItem: ContentItem): string | null {
  if (contentItem.externalId) {
    const normalizedExternalId = contentItem.externalId.replace(/^t3_/, '');
    if (/^[a-z0-9]+$/i.test(normalizedExternalId)) {
      return normalizedExternalId;
    }
  }

  if (contentItem.url) {
    try {
      const pathnameParts = new URL(contentItem.url).pathname.split('/').filter(Boolean);
      const commentsIndex = pathnameParts.indexOf('comments');
      if (commentsIndex >= 0 && pathnameParts[commentsIndex + 1]) {
        return pathnameParts[commentsIndex + 1];
      }
    } catch {
      // Fall back to returning null below.
    }
  }

  return null;
}

async function resolveContentItemSourceUrl(contentItem?: ContentItem | null): Promise<string | undefined> {
  if (!contentItem?.url) {
    return contentItem?.url;
  }

  const source = await db.query.botContentSources.findFirst({
    where: eq(botContentSources.id, contentItem.sourceId),
    columns: {
      type: true,
      subreddit: true,
    },
  });

  if (source?.type !== 'reddit' || !source.subreddit) {
    return contentItem.url;
  }

  const postId = extractRedditPostId(contentItem);
  if (!postId) {
    return contentItem.url;
  }

  return `https://www.reddit.com/r/${source.subreddit}/comments/${postId}/`;
}

/**
 * Create a post in the database.
 * Posts are created under the bot's own user account.
 * 
 * @param botId - The bot ID
 * @param content - The post content
 * @param sourceUrl - Optional source URL for link preview
 * @returns The created post
 */
async function createPostInDatabase(
  botId: string,
  content: string,
  contentItem?: ContentItem | null
): Promise<typeof posts.$inferSelect> {
  // Get bot config
  const bot = await db.query.bots.findFirst({
    where: eq(bots.id, botId),
  });

  if (!bot) {
    throw new PostCreationError(
      `Bot not found: ${botId}`,
      'BOT_NOT_FOUND'
    );
  }

  // Get the bot's own user account (not the owner)
  const botUser = await db.query.users.findFirst({
    where: eq(users.id, bot.userId),
  });

  if (!botUser) {
    throw new PostCreationError(
      `Bot user account not found for bot: ${botId}`,
      'BOT_NOT_FOUND'
    );
  }

  // Fetch link preview if source URL provided
  const sourceUrl = await resolveContentItemSourceUrl(contentItem);
  let linkPreview: Awaited<ReturnType<typeof fetchLinkPreview>> = null;
  if (sourceUrl) {
    linkPreview = await fetchLinkPreview(sourceUrl);
  }

  const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:3000';
  const postUuid = crypto.randomUUID();

  try {
    // Create the post under the bot's own user account
    const [post] = await db.insert(posts).values({
      userId: bot.userId, // Bot's own user ID, not the owner's
      botId: bot.id,
      content,
      apId: `https://${nodeDomain}/posts/${postUuid}`,
      apUrl: `https://${nodeDomain}/posts/${postUuid}`,
      linkPreviewUrl: linkPreview?.url || sourceUrl || null,
      linkPreviewTitle: linkPreview?.title || null,
      linkPreviewDescription: linkPreview?.description || null,
      linkPreviewImage: linkPreview?.image || null,
      linkPreviewType: linkPreview?.type || null,
      linkPreviewVideoUrl: linkPreview?.videoUrl || null,
      linkPreviewMediaJson: linkPreview?.media ? JSON.stringify(linkPreview.media) : null,
    }).returning();

    // Update bot user's post count
    await db.update(users)
      .set({ postsCount: botUser.postsCount + 1 })
      .where(eq(users.id, bot.userId));

    return post;
  } catch (error) {
    throw new PostCreationError(
      `Failed to create post in database: ${error instanceof Error ? error.message : String(error)}`,
      'DATABASE_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Federate a post to remote followers.
 * Uses swarm protocol for delivery to other Synapsis nodes.
 * This is a non-blocking operation that runs in the background.
 * 
 * @param post - The post to federate
 * @param botId - The bot ID
 */
async function federatePost(
  post: typeof posts.$inferSelect,
  botId: string
): Promise<void> {
  // Run federation in the background (non-blocking)
  (async () => {
    try {
      // Get bot config
      const bot = await db.query.bots.findFirst({
        where: eq(bots.id, botId),
      });

      if (!bot) {
        console.error('[Bot Federation] Bot not found:', botId);
        return;
      }

      // Get the bot's own user account
      const botUser = await db.query.users.findFirst({
        where: eq(users.id, bot.userId),
      });

      if (!botUser) {
        console.error('[Bot Federation] Bot user not found for bot:', botId);
        return;
      }

      const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:3000';

      // Use swarm delivery for bot posts
      const { deliverPostToSwarmFollowers } = await import('@/lib/swarm/interactions');

      const swarmResult = await deliverPostToSwarmFollowers(
        bot.userId,
        post,
        {
          handle: botUser.handle,
          displayName: botUser.displayName,
          avatarUrl: botUser.avatarUrl,
          isNsfw: botUser.isNsfw,
        },
        [], // No media for now
        nodeDomain
      );

      console.log(`[Bot Swarm] Post ${post.id} delivered to ${swarmResult.delivered} swarm nodes (${swarmResult.failed} failed)`);

      // Log federation activity
      await logActivity(
        botId,
        'post_created',
        {
          postId: post.id,
          swarm: {
            delivered: swarmResult.delivered,
            failed: swarmResult.failed,
          },
        },
        true
      );
    } catch (error) {
      console.error('[Bot Swarm] Error delivering post:', error);

      await logActivity(
        botId,
        'error',
        {
          type: 'federation',
          postId: post.id,
          error: error instanceof Error ? error.message : String(error),
        },
        false,
        error instanceof Error ? error.message : String(error)
      );
    }
  })();
}

/**
 * Trigger a post for a bot.
 * This is the main entry point for creating bot posts.
 * 
 * @param botId - The bot ID
 * @param options - Post creation options
 * @returns Post creation result
 * 
 * Validates: Requirements 5.4, 11.5, 11.6
 */
export async function triggerPost(
  botId: string,
  options: TriggerPostOptions = {}
): Promise<PostCreationResult> {
  const {
    sourceContentId,
    context,
    skipRateLimitCheck = false,
    skipValidation = false,
  } = options;

  try {
    // Get bot
    const bot = await getBotById(botId);
    if (!bot) {
      return {
        success: false,
        error: `Bot not found: ${botId}`,
        errorCode: 'BOT_NOT_FOUND',
      };
    }

    // Check if bot is active
    if (!bot.isActive) {
      return {
        success: false,
        error: 'Bot is not active',
        errorCode: 'BOT_INACTIVE',
      };
    }

    // Check if bot is suspended
    if (bot.isSuspended) {
      return {
        success: false,
        error: `Bot is suspended: ${bot.suspensionReason || 'No reason provided'}`,
        errorCode: 'BOT_SUSPENDED',
      };
    }

    // Check rate limits (Requirement 5.4)
    if (!skipRateLimitCheck) {
      const rateLimitCheck = await canPost(botId);
      if (!rateLimitCheck.allowed) {
        await logActivity(
          botId,
          'rate_limited',
          {
            reason: rateLimitCheck.reason,
            retryAfterSeconds: rateLimitCheck.retryAfterSeconds,
          },
          false,
          rateLimitCheck.reason
        );

        return {
          success: false,
          error: rateLimitCheck.reason || 'Rate limit exceeded',
          errorCode: 'RATE_LIMITED',
        };
      }
    }

    // Auto-fetch content from sources before posting
    // This ensures we have fresh content available
    const { getActiveSourcesByBot } = await import('./contentSource');
    const { fetchContentWithRetry } = await import('./contentFetcher');
    const activeSources = await getActiveSourcesByBot(botId);

    if (activeSources.length > 0) {
      console.log(`[Bot ${botId}] Fetching from ${activeSources.length} active sources...`);
      // Fetch from all active sources (with retry logic)
      const fetchResults = await Promise.allSettled(
        activeSources.map(source =>
          fetchContentWithRetry(source.id, 2, { maxItems: 10, timeout: 15000 })
        )
      );

      // Log results
      fetchResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          console.log(`[Bot ${botId}] Source ${activeSources[index].id}: ${result.value.success ? `fetched ${result.value.itemsFetched} items` : `failed: ${result.value.error}`}`);
        } else {
          console.error(`[Bot ${botId}] Source ${activeSources[index].id} error:`, result.reason);
        }
      });
    }

    // Select content (Requirement 5.4) - optional, bots can post without sources
    let contentItem: ContentItem | null = null;
    
    if (sourceContentId) {
      contentItem = await selectContentForPosting(botId, sourceContentId);
      if (!contentItem) {
        return {
          success: false,
          error: 'Specified content not found',
          errorCode: 'CONTENT_NOT_FOUND',
        };
      }
    } else {
      // Try to get content, but don't fail if none available
      contentItem = await selectContentForPosting(botId);
    }

    // Get bot from database for generation
    const dbBot = await db.query.bots.findFirst({
      where: eq(bots.id, botId),
      with: { user: true }, // Required for generatePostContent
    });

    if (!dbBot) {
      return {
        success: false,
        error: `Bot not found: ${botId}`,
        errorCode: 'BOT_NOT_FOUND',
      };
    }

    // Fetch previous posts for context (helps avoid repetition)
    const previousPosts = await getBotPreviousPosts(botId, 40);

    // Generate post content (Requirement 11.6)
    // Content item is optional - bot can generate posts based on personality alone
    let postContent = await generatePostContent(dbBot, contentItem || undefined, context, previousPosts);

    // Sanitize content
    postContent = sanitizePostContent(postContent);

    // Validate post content (Requirement 11.5)
    if (!skipValidation) {
      const validation = validatePostContent(postContent);

      if (!validation.valid) {
        await logActivity(
          botId,
          'error',
          {
            type: 'validation',
            contentItemId: contentItem?.id || null,
            errors: validation.errors,
            content: postContent,
          },
          false,
          `Validation failed: ${validation.errors.join(', ')}`
        );

        return {
          success: false,
          error: `Post validation failed: ${validation.errors.join(', ')}`,
          errorCode: 'VALIDATION_FAILED',
          contentItem: contentItem || undefined,
        };
      }
    }

    // Create post in database with source URL for link preview (if content item exists)
    const post = await createPostInDatabase(botId, postContent, contentItem);

    // Record post for rate limiting
    if (!skipRateLimitCheck) {
      await recordPost(botId);
    }

    // Mark content item as processed (only if we used one)
    if (contentItem) {
      await markContentItemProcessed(contentItem.id, post.id);
    }

    // Log successful post creation
    await logActivity(
      botId,
      'post_created',
      {
        postId: post.id,
        contentItemId: contentItem?.id || null,
        contentLength: postContent.length,
      },
      true
    );

    // Federate the post (non-blocking)
    await federatePost(post, botId);

    return {
      success: true,
      post,
      contentItem: contentItem || undefined,
    };
  } catch (error) {
    // Log error
    await logActivity(
      botId,
      'error',
      {
        type: 'post_creation',
        error: error instanceof Error ? error.message : String(error),
        sourceContentId,
      },
      false,
      error instanceof Error ? error.message : String(error)
    );

    if (error instanceof PostCreationError) {
      return {
        success: false,
        error: error.message,
        errorCode: error.code,
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      errorCode: 'DATABASE_ERROR',
    };
  }
}

/**
 * Trigger posts for multiple bots.
 * Useful for batch processing scheduled posts.
 * 
 * @param botIds - Array of bot IDs
 * @param options - Post creation options
 * @returns Array of results for each bot
 */
export async function triggerPostsForBots(
  botIds: string[],
  options: TriggerPostOptions = {}
): Promise<Array<{ botId: string; result: PostCreationResult }>> {
  const results = [];

  for (const botId of botIds) {
    const result = await triggerPost(botId, options);
    results.push({ botId, result });
  }

  return results;
}

/**
 * Get posting statistics for a bot.
 * 
 * @param botId - The bot ID
 * @returns Posting statistics
 */
export async function getPostingStats(botId: string): Promise<{
  totalPosts: number;
  postsToday: number;
  lastPostAt: Date | null;
  contentItemsProcessed: number;
  contentItemsRemaining: number;
}> {
  // Get bot
  const bot = await db.query.bots.findFirst({
    where: eq(bots.id, botId),
    with: {
      contentSources: true,
    },
  });

  if (!bot) {
    return {
      totalPosts: 0,
      postsToday: 0,
      lastPostAt: null,
      contentItemsProcessed: 0,
      contentItemsRemaining: 0,
    };
  }

  // Get user's post count
  const user = await db.query.users.findFirst({
    where: eq(users.id, bot.userId),
  });

  const totalPosts = user?.postsCount || 0;

  // Get posts today
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const postsToday = await db.query.posts.findMany({
    where: and(
      eq(posts.userId, bot.userId),
      // Note: This is a simplified query. In production, you'd want to use a proper date comparison
    ),
  });

  // Get content item stats
  const sourceIds = bot.contentSources?.map(s => s.id) || [];

  let contentItemsProcessed = 0;
  let contentItemsRemaining = 0;

  if (sourceIds.length > 0) {
    const allItems = await db.query.botContentItems.findMany({
      where: (items, { inArray }) => inArray(items.sourceId, sourceIds),
    });

    contentItemsProcessed = allItems.filter(item => item.isProcessed).length;
    contentItemsRemaining = allItems.filter(item => !item.isProcessed).length;
  }

  return {
    totalPosts,
    postsToday: postsToday.length,
    lastPostAt: bot.lastPostAt,
    contentItemsProcessed,
    contentItemsRemaining,
  };
}
