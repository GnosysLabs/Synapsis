/**
 * Content Source Service
 * 
 * Handles content source management for bots including adding, removing,
 * and validating content sources (RSS, Reddit, news APIs).
 * 
 * Requirements: 4.1, 4.6
 */

import { db, botContentSources, bots } from '@/db';
import { eq, and } from 'drizzle-orm';
import { encryptApiKey, serializeEncryptedData } from './encryption';

// ============================================
// TYPES
// ============================================

/**
 * Supported content source types.
 * 
 * Validates: Requirements 4.6
 */
export type ContentSourceType = 'rss' | 'reddit' | 'news_api' | 'brave_news' | 'youtube';

/**
 * Brave News configuration options.
 */
export interface BraveNewsConfig {
  /** Search query */
  query: string;
  /** Freshness filter: pd (24h), pw (7d), pm (31d), py (year) */
  freshness?: 'pd' | 'pw' | 'pm' | 'py';
  /** Country code (2-letter ISO) */
  country?: string;
  /** Search language */
  searchLang?: string;
  /** Number of results (max 50) */
  count?: number;
}

/**
 * News API configuration options for query builder.
 */
export interface NewsApiConfig {
  /** News API provider */
  provider: 'newsapi' | 'gnews' | 'newsdata';
  /** Search query/keywords */
  query: string;
  /** Category filter */
  category?: string;
  /** Country code */
  country?: string;
  /** Language */
  language?: string;
}

/**
 * Configuration for adding a content source.
 */
export interface ContentSourceConfig {
  /** Type of content source */
  type: ContentSourceType;
  /** URL for the content source */
  url: string;
  /** Subreddit name (required for Reddit sources) */
  subreddit?: string;
  /** API key for news APIs (required for news_api and brave_news sources) */
  apiKey?: string;
  /** Keywords for filtering content */
  keywords?: string[];
  /** Brave News specific configuration */
  braveNewsConfig?: BraveNewsConfig;
  /** News API query builder configuration */
  newsApiConfig?: NewsApiConfig;
}

/**
 * Content source entity returned from database.
 */
export interface ContentSource {
  id: string;
  botId: string;
  type: ContentSourceType;
  url: string;
  subreddit: string | null;
  keywords: string[] | null;
  sourceConfig: BraveNewsConfig | NewsApiConfig | null;
  isActive: boolean;
  lastFetchAt: Date | null;
  lastError: string | null;
  consecutiveErrors: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Validation result for content source configuration.
 */
export interface ContentSourceValidationResult {
  valid: boolean;
  errors: string[];
}

// ============================================
// CONSTANTS
// ============================================

/** Supported content source types */
export const SUPPORTED_SOURCE_TYPES: ContentSourceType[] = ['rss', 'reddit', 'news_api', 'brave_news', 'youtube'];

/** Maximum keywords per source */
export const MAX_KEYWORDS = 20;

/** Maximum keyword length */
export const MAX_KEYWORD_LENGTH = 100;

/** Reddit URL patterns */
const REDDIT_URL_PATTERNS = [
  /^https?:\/\/(www\.)?reddit\.com\/r\/[\w-]+/i,
  /^https?:\/\/(www\.)?old\.reddit\.com\/r\/[\w-]+/i,
];

/** RSS URL pattern (basic HTTP/HTTPS URL) */
const RSS_URL_PATTERN = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

/** News API URL patterns for common providers */
const NEWS_API_URL_PATTERNS = [
  /^https?:\/\/(www\.)?newsapi\.org/i,
  /^https?:\/\/(www\.)?gnews\.io/i,
  /^https?:\/\/(www\.)?newsdata\.io/i,
  /^https?:\/\/api\./i, // Generic API endpoint
];

/** Brave News API URL pattern */
const BRAVE_NEWS_URL_PATTERN = /^https?:\/\/api\.search\.brave\.com/i;

// ============================================
// ERROR CLASSES
// ============================================

/**
 * Base error class for content source operations.
 */
export class ContentSourceError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'ContentSourceError';
  }
}

/**
 * Error thrown when content source is not found.
 */
export class ContentSourceNotFoundError extends ContentSourceError {
  constructor(sourceId: string) {
    super(`Content source not found: ${sourceId}`, 'SOURCE_NOT_FOUND');
  }
}

/**
 * Error thrown when bot is not found.
 */
export class BotNotFoundError extends ContentSourceError {
  constructor(botId: string) {
    super(`Bot not found: ${botId}`, 'BOT_NOT_FOUND');
  }
}

/**
 * Error thrown when content source validation fails.
 */
export class ContentSourceValidationError extends ContentSourceError {
  constructor(message: string, public errors: string[] = []) {
    super(message, 'VALIDATION_ERROR');
  }
}

// ============================================
// VALIDATION FUNCTIONS
// ============================================

/**
 * Check if a source type is supported.
 * 
 * @param type - The source type to check
 * @returns True if the type is supported
 * 
 * Validates: Requirements 4.6
 */
export function isSupportedSourceType(type: string): type is ContentSourceType {
  return SUPPORTED_SOURCE_TYPES.includes(type as ContentSourceType);
}

/**
 * Validate a URL format.
 * 
 * @param url - The URL to validate
 * @returns True if the URL is valid
 */
export function isValidUrl(url: string): boolean {
  if (!url || typeof url !== 'string') {
    return false;
  }
  
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate a URL for a specific source type.
 * 
 * @param url - The URL to validate
 * @param type - The source type
 * @returns Validation errors (empty if valid)
 * 
 * Validates: Requirements 4.1
 */
export function validateSourceUrl(url: string, type: ContentSourceType): string[] {
  const errors: string[] = [];
  
  if (!url || typeof url !== 'string') {
    errors.push('URL is required');
    return errors;
  }
  
  const trimmedUrl = url.trim();
  
  if (trimmedUrl.length === 0) {
    errors.push('URL cannot be empty');
    return errors;
  }
  
  if (trimmedUrl.length > 2048) {
    errors.push('URL is too long (maximum 2048 characters)');
    return errors;
  }
  
  if (!isValidUrl(trimmedUrl)) {
    errors.push('URL must be a valid HTTP or HTTPS URL');
    return errors;
  }
  
  // Type-specific URL validation
  switch (type) {
    case 'rss':
      // RSS feeds can be any valid URL
      if (!RSS_URL_PATTERN.test(trimmedUrl)) {
        errors.push('Invalid RSS feed URL format');
      }
      break;
      
    case 'reddit':
      // Reddit URLs must point to a subreddit
      const isValidRedditUrl = REDDIT_URL_PATTERNS.some(pattern => pattern.test(trimmedUrl));
      if (!isValidRedditUrl) {
        errors.push('Reddit URL must be a valid subreddit URL (e.g., https://reddit.com/r/subreddit)');
      }
      break;
      
    case 'news_api':
      // News API URLs should be API endpoints
      const isValidNewsApiUrl = NEWS_API_URL_PATTERNS.some(pattern => pattern.test(trimmedUrl));
      if (!isValidNewsApiUrl) {
        errors.push('News API URL must be a valid API endpoint');
      }
      break;
      
    case 'brave_news':
      // Brave News URLs must point to the Brave Search API
      if (!BRAVE_NEWS_URL_PATTERN.test(trimmedUrl)) {
        errors.push('Brave News URL must be a valid Brave Search API endpoint');
      }
      break;
  }
  
  return errors;
}

/**
 * Validate source type.
 * 
 * @param type - The source type to validate
 * @returns Validation errors (empty if valid)
 * 
 * Validates: Requirements 4.1, 4.6
 */
export function validateSourceType(type: unknown): string[] {
  const errors: string[] = [];
  
  if (!type || typeof type !== 'string') {
    errors.push('Source type is required');
    return errors;
  }
  
  if (!isSupportedSourceType(type)) {
    errors.push(`Unsupported source type: ${type}. Supported types: ${SUPPORTED_SOURCE_TYPES.join(', ')}`);
  }
  
  return errors;
}

/**
 * Validate subreddit name for Reddit sources.
 * 
 * @param subreddit - The subreddit name
 * @param type - The source type
 * @returns Validation errors (empty if valid)
 */
export function validateSubreddit(subreddit: unknown, type: ContentSourceType): string[] {
  const errors: string[] = [];
  
  if (type !== 'reddit') {
    return errors;
  }
  
  if (!subreddit || typeof subreddit !== 'string') {
    errors.push('Subreddit name is required for Reddit sources');
    return errors;
  }
  
  const trimmed = subreddit.trim();
  
  // Subreddit names: 3-21 characters, alphanumeric and underscores
  if (!/^[a-zA-Z0-9_]{3,21}$/.test(trimmed)) {
    errors.push('Subreddit name must be 3-21 characters, alphanumeric and underscores only');
  }
  
  return errors;
}

/**
 * Validate API key for news API sources.
 * 
 * @param apiKey - The API key
 * @param type - The source type
 * @returns Validation errors (empty if valid)
 */
export function validateNewsApiKey(apiKey: unknown, type: ContentSourceType): string[] {
  const errors: string[] = [];
  
  if (type !== 'news_api' && type !== 'brave_news') {
    return errors;
  }
  
  if (!apiKey || typeof apiKey !== 'string') {
    errors.push(`API key is required for ${type === 'brave_news' ? 'Brave News' : 'news API'} sources`);
    return errors;
  }
  
  const trimmed = apiKey.trim();
  
  if (trimmed.length < 10) {
    errors.push('API key is too short');
  }
  
  if (trimmed.length > 256) {
    errors.push('API key is too long');
  }
  
  return errors;
}

/**
 * Validate keywords array.
 * 
 * @param keywords - The keywords array
 * @returns Validation errors (empty if valid)
 */
export function validateKeywords(keywords: unknown): string[] {
  const errors: string[] = [];
  
  // Keywords are optional
  if (keywords === undefined || keywords === null) {
    return errors;
  }
  
  if (!Array.isArray(keywords)) {
    errors.push('Keywords must be an array');
    return errors;
  }
  
  if (keywords.length > MAX_KEYWORDS) {
    errors.push(`Maximum ${MAX_KEYWORDS} keywords allowed`);
  }
  
  for (let i = 0; i < keywords.length; i++) {
    const keyword = keywords[i];
    
    if (typeof keyword !== 'string') {
      errors.push(`Keyword at index ${i} must be a string`);
      continue;
    }
    
    const trimmed = keyword.trim();
    
    if (trimmed.length === 0) {
      errors.push(`Keyword at index ${i} cannot be empty`);
    }
    
    if (trimmed.length > MAX_KEYWORD_LENGTH) {
      errors.push(`Keyword at index ${i} is too long (maximum ${MAX_KEYWORD_LENGTH} characters)`);
    }
  }
  
  return errors;
}

/**
 * Validate a complete content source configuration.
 * 
 * @param config - The configuration to validate
 * @returns Validation result with errors
 * 
 * Validates: Requirements 4.1, 4.6
 */
export function validateContentSourceConfig(config: unknown): ContentSourceValidationResult {
  const errors: string[] = [];
  
  if (!config || typeof config !== 'object') {
    return {
      valid: false,
      errors: ['Content source configuration must be an object'],
    };
  }
  
  const configObj = config as Record<string, unknown>;
  
  // Validate type first (needed for other validations)
  const typeErrors = validateSourceType(configObj.type);
  errors.push(...typeErrors);
  
  // If type is invalid, we can't do type-specific validation
  if (typeErrors.length > 0) {
    return { valid: false, errors };
  }
  
  const type = configObj.type as ContentSourceType;
  
  // Validate URL
  errors.push(...validateSourceUrl(configObj.url as string, type));
  
  // Validate type-specific fields
  errors.push(...validateSubreddit(configObj.subreddit, type));
  errors.push(...validateNewsApiKey(configObj.apiKey, type));
  
  // Validate optional fields
  errors.push(...validateKeywords(configObj.keywords));
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Extract subreddit name from a Reddit URL.
 * 
 * @param url - The Reddit URL
 * @returns The subreddit name or null
 */
export function extractSubredditFromUrl(url: string): string | null {
  const match = url.match(/reddit\.com\/r\/([a-zA-Z0-9_]+)/i);
  return match ? match[1] : null;
}

/**
 * Build a Brave News API URL from configuration.
 * 
 * @param config - The Brave News configuration
 * @returns The constructed API URL
 */
export function buildBraveNewsUrl(config: BraveNewsConfig): string {
  const url = new URL('https://api.search.brave.com/res/v1/news/search');
  
  url.searchParams.set('q', config.query);
  
  if (config.freshness) {
    url.searchParams.set('freshness', config.freshness);
  }
  
  if (config.country) {
    url.searchParams.set('country', config.country);
  }
  
  if (config.searchLang) {
    url.searchParams.set('search_lang', config.searchLang);
  }
  
  if (config.count) {
    url.searchParams.set('count', String(Math.min(config.count, 50)));
  }
  
  return url.toString();
}

/**
 * Build a News API URL from configuration.
 * 
 * @param config - The News API configuration
 * @returns The constructed API URL
 */
export function buildNewsApiUrl(config: NewsApiConfig): string {
  let baseUrl: string;
  const params = new URLSearchParams();
  
  switch (config.provider) {
    case 'newsapi':
      baseUrl = 'https://newsapi.org/v2/everything';
      params.set('q', config.query);
      if (config.language) params.set('language', config.language);
      break;
      
    case 'gnews':
      baseUrl = 'https://gnews.io/api/v4/search';
      params.set('q', config.query);
      if (config.country) params.set('country', config.country);
      if (config.language) params.set('lang', config.language);
      if (config.category) params.set('topic', config.category);
      break;
      
    case 'newsdata':
      baseUrl = 'https://newsdata.io/api/1/news';
      params.set('q', config.query);
      if (config.country) params.set('country', config.country);
      if (config.language) params.set('language', config.language);
      if (config.category) params.set('category', config.category);
      break;
      
    default:
      throw new Error(`Unknown news API provider: ${config.provider}`);
  }
  
  return `${baseUrl}?${params.toString()}`;
}

/**
 * Convert database row to ContentSource interface.
 */
function dbSourceToContentSource(dbSource: typeof botContentSources.$inferSelect): ContentSource {
  return {
    id: dbSource.id,
    botId: dbSource.botId,
    type: dbSource.type as ContentSourceType,
    url: dbSource.url,
    subreddit: dbSource.subreddit,
    keywords: dbSource.keywords ? JSON.parse(dbSource.keywords) : null,
    sourceConfig: dbSource.sourceConfig ? JSON.parse(dbSource.sourceConfig) : null,
    isActive: dbSource.isActive,
    lastFetchAt: dbSource.lastFetchAt,
    lastError: dbSource.lastError,
    consecutiveErrors: dbSource.consecutiveErrors,
    createdAt: dbSource.createdAt,
    updatedAt: dbSource.updatedAt,
  };
}

// ============================================
// CONTENT SOURCE MANAGEMENT FUNCTIONS
// ============================================

/**
 * Add a content source to a bot.
 * 
 * @param botId - The ID of the bot
 * @param config - The content source configuration
 * @returns The created content source
 * @throws BotNotFoundError if bot doesn't exist
 * @throws ContentSourceValidationError if configuration is invalid
 * 
 * Validates: Requirements 4.1, 4.6
 */
export async function addSource(
  botId: string,
  config: ContentSourceConfig
): Promise<ContentSource> {
  // Validate configuration
  const validation = validateContentSourceConfig(config);
  if (!validation.valid) {
    throw new ContentSourceValidationError(
      `Invalid content source configuration: ${validation.errors.join(', ')}`,
      validation.errors
    );
  }
  
  // Check if bot exists
  const bot = await db.query.bots.findFirst({
    where: { id: botId },
    columns: { id: true },
  });
  
  if (!bot) {
    throw new BotNotFoundError(botId);
  }
  
  // Prepare data for insertion
  const insertData: typeof botContentSources.$inferInsert = {
    botId,
    type: config.type,
    url: config.url.trim(),
    subreddit: config.type === 'reddit' 
      ? (config.subreddit?.trim() || extractSubredditFromUrl(config.url))
      : null,
    keywords: config.keywords && config.keywords.length > 0 
      ? JSON.stringify(config.keywords.map(k => k.trim()))
      : null,
    sourceConfig: config.braveNewsConfig 
      ? JSON.stringify(config.braveNewsConfig)
      : config.newsApiConfig 
        ? JSON.stringify(config.newsApiConfig)
        : null,
    isActive: true,
    consecutiveErrors: 0,
  };
  
  // Encrypt API key if provided (for news_api and brave_news sources)
  if ((config.type === 'news_api' || config.type === 'brave_news') && config.apiKey) {
    const encryptedApiKey = encryptApiKey(config.apiKey);
    insertData.apiKeyEncrypted = serializeEncryptedData(encryptedApiKey);
  }
  
  // Insert the content source
  const [createdSource] = await db
    .insert(botContentSources)
    .values(insertData)
    .returning();
  
  return dbSourceToContentSource(createdSource);
}

/**
 * Remove a content source.
 * 
 * @param sourceId - The ID of the content source to remove
 * @throws ContentSourceNotFoundError if source doesn't exist
 * 
 * Validates: Requirements 4.1
 */
export async function removeSource(sourceId: string): Promise<void> {
  // Check if source exists
  const existingSource = await db.query.botContentSources.findFirst({
    where: { id: sourceId },
    columns: { id: true },
  });
  
  if (!existingSource) {
    throw new ContentSourceNotFoundError(sourceId);
  }
  
  // Delete the source (cascade will handle content items)
  await db.delete(botContentSources).where(eq(botContentSources.id, sourceId));
}

/**
 * Get a content source by ID.
 * 
 * @param sourceId - The ID of the content source
 * @returns The content source or null if not found
 */
export async function getSourceById(sourceId: string): Promise<ContentSource | null> {
  const source = await db.query.botContentSources.findFirst({
    where: { id: sourceId },
  });
  
  if (!source) {
    return null;
  }
  
  return dbSourceToContentSource(source);
}

/**
 * Get all content sources for a bot.
 * 
 * @param botId - The ID of the bot
 * @returns Array of content sources
 * 
 * Validates: Requirements 4.6
 */
export async function getSourcesByBot(botId: string): Promise<ContentSource[]> {
  const sources = await db.query.botContentSources.findMany({
    where: { botId: botId },
    orderBy: (sources, { desc }) => [desc(sources.createdAt)],
  });
  
  return sources.map(dbSourceToContentSource);
}

/**
 * Get all active content sources for a bot.
 * 
 * @param botId - The ID of the bot
 * @returns Array of active content sources
 */
export async function getActiveSourcesByBot(botId: string): Promise<ContentSource[]> {
  const sources = await db.query.botContentSources.findMany({
    where: { AND: [{ botId: botId }, { isActive: true }] },
    orderBy: (sources, { desc }) => [desc(sources.createdAt)],
  });
  
  return sources.map(dbSourceToContentSource);
}

/**
 * Update a content source.
 * 
 * @param sourceId - The ID of the content source
 * @param updates - The fields to update
 * @returns The updated content source
 * @throws ContentSourceNotFoundError if source doesn't exist
 * @throws ContentSourceValidationError if updates are invalid
 */
export async function updateSource(
  sourceId: string,
  updates: Partial<Pick<ContentSourceConfig, 'url' | 'keywords'>> & {
    isActive?: boolean;
  }
): Promise<ContentSource> {
  // Check if source exists
  const existingSource = await db.query.botContentSources.findFirst({
    where: { id: sourceId },
  });
  
  if (!existingSource) {
    throw new ContentSourceNotFoundError(sourceId);
  }
  
  const errors: string[] = [];
  
  // Validate updates
  if (updates.url !== undefined) {
    errors.push(...validateSourceUrl(updates.url, existingSource.type as ContentSourceType));
  }
  
  if (updates.keywords !== undefined) {
    errors.push(...validateKeywords(updates.keywords));
  }
  
  if (errors.length > 0) {
    throw new ContentSourceValidationError(
      `Invalid update: ${errors.join(', ')}`,
      errors
    );
  }
  
  // Build update data
  const updateData: Partial<typeof botContentSources.$inferInsert> = {
    updatedAt: new Date(),
  };
  
  if (updates.url !== undefined) {
    updateData.url = updates.url.trim();
  }
  
  if (updates.keywords !== undefined) {
    updateData.keywords = updates.keywords && updates.keywords.length > 0
      ? JSON.stringify(updates.keywords.map(k => k.trim()))
      : null;
  }
  
  if (updates.isActive !== undefined) {
    updateData.isActive = updates.isActive;
  }
  
  // Update the source
  const [updatedSource] = await db
    .update(botContentSources)
    .set(updateData)
    .where(eq(botContentSources.id, sourceId))
    .returning();
  
  return dbSourceToContentSource(updatedSource);
}

/**
 * Activate a content source.
 * 
 * @param sourceId - The ID of the content source
 * @throws ContentSourceNotFoundError if source doesn't exist
 */
export async function activateSource(sourceId: string): Promise<void> {
  await updateSource(sourceId, { isActive: true });
}

/**
 * Deactivate a content source.
 * 
 * @param sourceId - The ID of the content source
 * @throws ContentSourceNotFoundError if source doesn't exist
 */
export async function deactivateSource(sourceId: string): Promise<void> {
  await updateSource(sourceId, { isActive: false });
}

/**
 * Check if a bot owns a specific content source.
 * 
 * @param botId - The ID of the bot
 * @param sourceId - The ID of the content source
 * @returns True if the bot owns the source
 */
export async function botOwnsSource(botId: string, sourceId: string): Promise<boolean> {
  const source = await db.query.botContentSources.findFirst({
    where: { AND: [{ id: sourceId }, { botId: botId }] },
    columns: { id: true },
  });
  
  return source !== undefined;
}

/**
 * Get the count of content sources for a bot.
 * 
 * @param botId - The ID of the bot
 * @returns The number of content sources
 */
export async function getSourceCountForBot(botId: string): Promise<number> {
  const sources = await db.query.botContentSources.findMany({
    where: { botId: botId },
    columns: { id: true },
  });
  
  return sources.length;
}

/**
 * Get content sources by type for a bot.
 * 
 * @param botId - The ID of the bot
 * @param type - The source type to filter by
 * @returns Array of content sources of the specified type
 * 
 * Validates: Requirements 4.6
 */
export async function getSourcesByType(
  botId: string,
  type: ContentSourceType
): Promise<ContentSource[]> {
  const sources = await db.query.botContentSources.findMany({
    where: { AND: [{ botId: botId }, { type: type }] },
    orderBy: (sources, { desc }) => [desc(sources.createdAt)],
  });
  
  return sources.map(dbSourceToContentSource);
}
