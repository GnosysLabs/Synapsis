/**
 * Content Generator Module
 * 
 * Generates posts and replies using LLM providers with personality context.
 * Handles content truncation for long sources and evaluates content interest
 * for autonomous posting decisions.
 * 
 * Requirements: 3.2, 3.5, 6.2, 11.1, 11.2, 11.3
 */

import { LLMClient, LLMMessage, LLMCompletionRequest } from './llmClient';
import { PersonalityConfig, buildPromptWithPersonality } from './personality';
import type { LLMProvider } from './encryption';

// ============================================
// TYPES
// ============================================

/**
 * Bot data required for content generation.
 */
export interface Bot {
  id: string;
  name: string;
  handle: string;
  personalityConfig: PersonalityConfig;
  llmProvider: LLMProvider;
  llmModel: string;
  llmEndpoint?: string | null;
  llmApiKeyEncrypted: string;
}

/**
 * Content item from external sources.
 */
export interface ContentItem {
  id: string;
  sourceId: string;
  externalId?: string;
  title: string;
  content: string | null;
  url: string;
  publishedAt: Date;
}

/**
 * Post data for reply context.
 */
export interface Post {
  id: string;
  userId: string;
  content: string;
  createdAt: Date;
  author?: {
    handle: string;
    displayName?: string | null;
  };
}

/**
 * Generated content result.
 */
export interface GeneratedContent {
  text: string;
  tokensUsed: number;
  model: string;
}

/**
 * Content interest evaluation result.
 */
export interface ContentInterestResult {
  interesting: boolean;
  reason: string;
}

/**
 * Error thrown by content generator operations.
 */
export class ContentGeneratorError extends Error {
  constructor(
    message: string,
    public code: ContentGeneratorErrorCode,
    public cause?: Error
  ) {
    super(message);
    this.name = 'ContentGeneratorError';
  }
}

export type ContentGeneratorErrorCode =
  | 'LLM_ERROR'
  | 'INVALID_BOT'
  | 'INVALID_CONTENT'
  | 'GENERATION_FAILED'
  | 'EVALUATION_FAILED';

// ============================================
// CONSTANTS
// ============================================

/**
 * Maximum character length for source content before truncation.
 * Validates: Requirements 11.3
 */
export const MAX_SOURCE_CONTENT_LENGTH = 4000;

/**
 * Maximum character length for conversation context.
 */
export const MAX_CONVERSATION_CONTEXT_LENGTH = 2000;

/**
 * Maximum character length for previous posts context.
 */
export const MAX_PREVIOUS_POSTS_CONTEXT_LENGTH = 8000;

/**
 * Truncation suffix added to truncated content.
 */
export const TRUNCATION_SUFFIX = '... [content truncated]';

/**
 * Default max tokens for post generation.
 */
export const DEFAULT_POST_MAX_TOKENS = 500;

/**
 * Default max tokens for reply generation.
 */
export const DEFAULT_REPLY_MAX_TOKENS = 300;

/**
 * Default max tokens for interest evaluation.
 */
export const DEFAULT_EVALUATION_MAX_TOKENS = 150;

// ============================================
// CONTENT TRUNCATION
// ============================================

/**
 * Truncate content to a maximum length.
 * Attempts to truncate at sentence or word boundaries when possible.
 * 
 * @param content - The content to truncate
 * @param maxLength - Maximum length (default: MAX_SOURCE_CONTENT_LENGTH)
 * @returns Truncated content with suffix if truncated
 * 
 * Validates: Requirements 11.3
 */
export function truncateContent(
  content: string,
  maxLength: number = MAX_SOURCE_CONTENT_LENGTH
): string {
  if (!content || content.length <= maxLength) {
    return content || '';
  }
  
  // Account for truncation suffix length
  const targetLength = maxLength - TRUNCATION_SUFFIX.length;
  
  if (targetLength <= 0) {
    return TRUNCATION_SUFFIX;
  }
  
  // Try to find a sentence boundary (., !, ?)
  const sentenceEnd = findLastBoundary(content, targetLength, /[.!?]\s/g);
  if (sentenceEnd > targetLength * 0.5) {
    return content.slice(0, sentenceEnd + 1).trim() + TRUNCATION_SUFFIX;
  }
  
  // Try to find a word boundary
  const wordEnd = findLastBoundary(content, targetLength, /\s/g);
  if (wordEnd > targetLength * 0.5) {
    return content.slice(0, wordEnd).trim() + TRUNCATION_SUFFIX;
  }
  
  // Hard truncate if no good boundary found
  return content.slice(0, targetLength).trim() + TRUNCATION_SUFFIX;
}

/**
 * Find the last occurrence of a pattern before a given position.
 * 
 * @param text - Text to search
 * @param maxPos - Maximum position to search up to
 * @param pattern - Regex pattern to find
 * @returns Position of last match, or -1 if not found
 */
function findLastBoundary(text: string, maxPos: number, pattern: RegExp): number {
  let lastPos = -1;
  let match: RegExpExecArray | null;
  
  while ((match = pattern.exec(text)) !== null) {
    if (match.index >= maxPos) break;
    lastPos = match.index;
  }
  
  return lastPos;
}

/**
 * Check if content was truncated.
 * 
 * @param content - Content to check
 * @returns True if content ends with truncation suffix
 */
export function isContentTruncated(content: string): boolean {
  return content.endsWith(TRUNCATION_SUFFIX);
}

// ============================================
// PROMPT BUILDING
// ============================================

/**
 * Build a system prompt for post generation.
 * Includes personality context and instructions.
 * 
 * @param personality - Bot's personality configuration
 * @param hasSourceContent - Whether the post has source content with a URL
 * @returns System prompt string
 * 
 * Validates: Requirements 3.2, 11.1
 */
export function buildPostSystemPrompt(personality: PersonalityConfig, hasSourceContent: boolean = true): string {
  let prompt = personality.systemPrompt;
  
  if (personality.responseStyle) {
    prompt += `\n\nResponse Style: ${personality.responseStyle}`;
  }
  
  if (hasSourceContent) {
    // Instructions for posts with source content (include URL)
    prompt += `\n\nIMPORTANT: Your posts MUST be under 450 characters (not including the URL). This leaves room for the source link. This is a strict limit.

Instructions for creating posts:
- Create engaging, original content based on the source material
- Add your own perspective or commentary
- Keep the text concise - aim for 200-400 characters
- ALWAYS include the source URL at the end of your post
- Do not simply copy or summarize - add value with your unique voice
- Do NOT use hashtags
- Write like a human, not a marketing bot
- AVOID repeating themes, phrases, or sentence structures from your previous posts
- Format: [Your commentary] [URL]`;
  } else {
    // Instructions for original posts without source content (no URL needed)
    prompt += `\n\nIMPORTANT: Your posts MUST be under 500 characters. This is a strict limit.

Instructions for creating posts:
- Create engaging, original content that fits your personality
- Keep the text concise - aim for 100-400 characters
- Do NOT include any URLs or links
- Do NOT use hashtags
- Write like a human, not a marketing bot
- Be creative and stay in character
- AVOID repeating themes, phrases, or sentence structures from your previous posts
- Each post should feel fresh and different while maintaining your voice`;
  }
  
  return prompt;
}

/**
 * Build a system prompt for reply generation.
 * Includes personality context and reply-specific instructions.
 * 
 * @param personality - Bot's personality configuration
 * @returns System prompt string
 * 
 * Validates: Requirements 3.5
 */
export function buildReplySystemPrompt(personality: PersonalityConfig): string {
  let prompt = personality.systemPrompt;
  
  if (personality.responseStyle) {
    prompt += `\n\nResponse Style: ${personality.responseStyle}`;
  }
  
  prompt += `\n\nInstructions for replying:
- Respond directly to what the user said
- Be conversational and engaging
- Stay in character with your personality
- Keep replies concise and relevant
- Be respectful and constructive`;
  
  return prompt;
}

/**
 * Build a system prompt for content interest evaluation.
 * 
 * @param personality - Bot's personality configuration
 * @returns System prompt string
 * 
 * Validates: Requirements 6.2
 */
export function buildEvaluationSystemPrompt(personality: PersonalityConfig): string {
  let prompt = personality.systemPrompt;
  
  prompt += `\n\nYou are evaluating whether content is interesting enough to share with your followers.
Consider:
- Is this content relevant to your interests and expertise?
- Would your followers find this valuable or engaging?
- Is this timely or newsworthy?
- Does this align with your personality and posting style?

Respond with a JSON object containing:
- "interesting": true or false
- "reason": a brief explanation of your decision`;
  
  return prompt;
}

/**
 * Build user message for post generation from source content.
 * 
 * @param sourceContent - Source content to post about
 * @param context - Optional additional context
 * @param previousPosts - Optional array of previous post contents for context
 * @returns User message string
 */
export function buildPostUserMessage(
  sourceContent?: ContentItem,
  context?: string,
  previousPosts?: string[]
): string {
  let message = '';
  
  // Add previous posts context if available
  if (previousPosts && previousPosts.length > 0) {
    message += 'Your recent posts (for context - avoid repeating similar content):\n';
    
    // Truncate previous posts if too long
    let contextLength = 0;
    const relevantPosts: string[] = [];
    
    for (const post of previousPosts) {
      if (contextLength + post.length > MAX_PREVIOUS_POSTS_CONTEXT_LENGTH) {
        break;
      }
      relevantPosts.push(`- ${post}`);
      contextLength += post.length;
    }
    
    message += relevantPosts.join('\n');
    message += '\n\n---\n\n';
  }
  
  if (!sourceContent) {
    if (context) {
      message += `Create a post about the following:\n\n${context}`;
    } else {
      message += 'Create an engaging post for your followers.';
    }
    return message;
  }
  
  const truncatedContent = truncateContent(sourceContent.content || '');
  
  message += `Create a post about the following content:\n\n`;
  message += `Title: ${sourceContent.title}\n`;
  message += `URL: ${sourceContent.url}\n`;
  
  if (truncatedContent) {
    message += `\nContent:\n${truncatedContent}`;
  }
  
  if (context) {
    message += `\n\nAdditional context: ${context}`;
  }
  
  return message;
}

/**
 * Build user message for reply generation.
 * 
 * @param mentionPost - The post that mentioned the bot
 * @param conversationContext - Previous posts in the conversation
 * @returns User message string
 */
export function buildReplyUserMessage(
  mentionPost: Post,
  conversationContext: Post[]
): string {
  let message = '';
  
  // Add conversation context if available
  if (conversationContext.length > 0) {
    message += 'Conversation context:\n';
    
    // Truncate conversation context if too long
    let contextLength = 0;
    const relevantContext: string[] = [];
    
    // Process in reverse to get most recent context first
    for (let i = conversationContext.length - 1; i >= 0; i--) {
      const post = conversationContext[i];
      const authorHandle = post.author?.handle || 'unknown';
      const postText = `@${authorHandle}: ${post.content}`;
      
      if (contextLength + postText.length > MAX_CONVERSATION_CONTEXT_LENGTH) {
        break;
      }
      
      relevantContext.unshift(postText);
      contextLength += postText.length;
    }
    
    message += relevantContext.join('\n');
    message += '\n\n';
  }
  
  // Add the mention post
  const authorHandle = mentionPost.author?.handle || 'unknown';
  message += `Reply to this post from @${authorHandle}:\n`;
  message += mentionPost.content;
  
  return message;
}

/**
 * Build user message for content interest evaluation.
 * 
 * @param content - Content to evaluate
 * @returns User message string
 */
export function buildEvaluationUserMessage(content: ContentItem): string {
  const truncatedContent = truncateContent(content.content || '', 2000);
  
  let message = `Evaluate whether you should share this content:\n\n`;
  message += `Title: ${content.title}\n`;
  message += `URL: ${content.url}\n`;
  
  if (truncatedContent) {
    message += `\nContent:\n${truncatedContent}`;
  }
  
  message += `\n\nRespond with JSON: {"interesting": true/false, "reason": "your explanation"}`;
  
  return message;
}

// ============================================
// CONTENT GENERATOR CLASS
// ============================================

/**
 * Content Generator for creating posts and replies using LLM.
 * 
 * Validates: Requirements 3.2, 3.5, 6.2, 11.1, 11.2, 11.3
 */
export class ContentGenerator {
  private llmClient: LLMClient;
  private bot: Bot;
  
  /**
   * Create a new content generator for a bot.
   * 
   * @param bot - Bot configuration
   * @param llmClient - Optional LLM client (created from bot config if not provided)
   */
  constructor(bot: Bot, llmClient?: LLMClient) {
    this.bot = bot;
    this.llmClient = llmClient || new LLMClient({
      provider: bot.llmProvider,
      apiKey: bot.llmApiKeyEncrypted,
      model: bot.llmModel,
      endpoint: bot.llmEndpoint,
    });
  }
  
  /**
   * Generate a post with personality context.
   * 
   * @param sourceContent - Optional source content to post about
   * @param context - Optional additional context
   * @param previousPosts - Optional array of previous post contents for context
   * @returns Generated content with token usage
   * 
   * Validates: Requirements 3.2, 11.1, 11.2, 11.3
   */
  async generatePost(
    sourceContent?: ContentItem,
    context?: string,
    previousPosts?: string[]
  ): Promise<GeneratedContent> {
    const hasSourceContent = !!sourceContent;
    const systemPrompt = buildPostSystemPrompt(this.bot.personalityConfig, hasSourceContent);
    const userMessage = buildPostUserMessage(sourceContent, context, previousPosts);
    
    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];
    
    const request: LLMCompletionRequest = {
      messages,
      temperature: this.bot.personalityConfig.temperature,
      maxTokens: this.bot.personalityConfig.maxTokens || DEFAULT_POST_MAX_TOKENS,
    };
    
    try {
      const response = await this.llmClient.generateCompletion(request);
      
      return {
        text: response.content.trim(),
        tokensUsed: response.tokensUsed.total,
        model: response.model,
      };
    } catch (error) {
      throw new ContentGeneratorError(
        `Failed to generate post: ${error instanceof Error ? error.message : String(error)}`,
        'LLM_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }
  
  /**
   * Generate a reply with conversation context.
   * 
   * @param mentionPost - The post that mentioned the bot
   * @param conversationContext - Previous posts in the conversation
   * @returns Generated content with token usage
   * 
   * Validates: Requirements 3.5
   */
  async generateReply(
    mentionPost: Post,
    conversationContext: Post[] = []
  ): Promise<GeneratedContent> {
    const systemPrompt = buildReplySystemPrompt(this.bot.personalityConfig);
    const userMessage = buildReplyUserMessage(mentionPost, conversationContext);
    
    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];
    
    const request: LLMCompletionRequest = {
      messages,
      temperature: this.bot.personalityConfig.temperature,
      maxTokens: Math.min(
        this.bot.personalityConfig.maxTokens || DEFAULT_REPLY_MAX_TOKENS,
        DEFAULT_REPLY_MAX_TOKENS
      ),
    };
    
    try {
      const response = await this.llmClient.generateCompletion(request);
      
      return {
        text: response.content.trim(),
        tokensUsed: response.tokensUsed.total,
        model: response.model,
      };
    } catch (error) {
      throw new ContentGeneratorError(
        `Failed to generate reply: ${error instanceof Error ? error.message : String(error)}`,
        'LLM_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }
  
  /**
   * Evaluate whether content is interesting enough to post about.
   * Used for autonomous posting decisions.
   * 
   * @param content - Content to evaluate
   * @returns Interest evaluation result
   * 
   * Validates: Requirements 6.2
   */
  async evaluateContentInterest(
    content: ContentItem
  ): Promise<ContentInterestResult> {
    const systemPrompt = buildEvaluationSystemPrompt(this.bot.personalityConfig);
    const userMessage = buildEvaluationUserMessage(content);
    
    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];
    
    const request: LLMCompletionRequest = {
      messages,
      temperature: 0.3, // Lower temperature for more consistent evaluation
      maxTokens: DEFAULT_EVALUATION_MAX_TOKENS,
    };
    
    try {
      const response = await this.llmClient.generateCompletion(request);
      
      // Parse the JSON response
      const result = parseInterestResponse(response.content);
      
      return result;
    } catch (error) {
      throw new ContentGeneratorError(
        `Failed to evaluate content interest: ${error instanceof Error ? error.message : String(error)}`,
        'EVALUATION_FAILED',
        error instanceof Error ? error : undefined
      );
    }
  }
  
  /**
   * Get the bot associated with this generator.
   */
  getBot(): Bot {
    return this.bot;
  }
  
  /**
   * Get the LLM client used by this generator.
   */
  getLLMClient(): LLMClient {
    return this.llmClient;
  }
}

// ============================================
// RESPONSE PARSING
// ============================================

/**
 * Parse the interest evaluation response from LLM.
 * Handles various response formats and extracts the boolean result.
 * 
 * @param response - Raw LLM response
 * @returns Parsed interest result
 */
export function parseInterestResponse(response: string): ContentInterestResult {
  // Try to parse as JSON first
  try {
    // Extract JSON from response (may be wrapped in markdown code blocks)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      
      // Handle various property names
      const interesting = parsed.interesting ?? parsed.isInteresting ?? parsed.interest ?? false;
      const reason = parsed.reason ?? parsed.explanation ?? parsed.rationale ?? 'No reason provided';
      
      return {
        interesting: Boolean(interesting),
        reason: String(reason),
      };
    }
  } catch {
    // JSON parsing failed, try text analysis
  }
  
  // Fallback: analyze text response
  const lowerResponse = response.toLowerCase();
  
  // Look for clear indicators
  const positiveIndicators = ['yes', 'true', 'interesting', 'share', 'post', 'relevant'];
  const negativeIndicators = ['no', 'false', 'not interesting', 'skip', 'irrelevant'];
  
  let positiveScore = 0;
  let negativeScore = 0;
  
  for (const indicator of positiveIndicators) {
    if (lowerResponse.includes(indicator)) positiveScore++;
  }
  
  for (const indicator of negativeIndicators) {
    if (lowerResponse.includes(indicator)) negativeScore++;
  }
  
  return {
    interesting: positiveScore > negativeScore,
    reason: response.slice(0, 200), // Use first 200 chars as reason
  };
}

// ============================================
// FACTORY FUNCTIONS
// ============================================

/**
 * Create a content generator for a bot.
 * 
 * @param bot - Bot configuration
 * @returns Content generator instance
 */
export function createContentGenerator(bot: Bot): ContentGenerator {
  return new ContentGenerator(bot);
}

/**
 * Create a content generator with a custom LLM client.
 * Useful for testing or custom configurations.
 * 
 * @param bot - Bot configuration
 * @param llmClient - Custom LLM client
 * @returns Content generator instance
 */
export function createContentGeneratorWithClient(
  bot: Bot,
  llmClient: LLMClient
): ContentGenerator {
  return new ContentGenerator(bot, llmClient);
}
