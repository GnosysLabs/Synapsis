/**
 * Content Fetcher Module
 * 
 * Fetches content from RSS, Reddit, and news API sources with exponential backoff
 * retry logic on failures. Tracks consecutive errors per source and stores
 * fetched content items in the database.
 * 
 * Requirements: 4.5, 4.7
 * Validates: Property 13 - Content Item Storage
 * Validates: Property 15 - Fetch Error Retry with Backoff
 */

import { db, botContentSources, botContentItems } from '@/db';
import { eq, and } from 'drizzle-orm';
import { parseRSSFeed, FeedItem } from './rssParser';
import { ContentSource, ContentSourceType, getSourceById, BraveNewsConfig } from './contentSource';
import { decryptApiKey, deserializeEncryptedData } from './encryption';

// ============================================
// TYPES
// ============================================

/**
 * Result of a content fetch operation.
 */
export interface FetchResult {
  success: boolean;
  sourceId: string;
  itemsFetched: number;
  itemsStored: number;
  error?: string;
  warnings: string[];
}

/**
 * Content item to be stored in the database.
 */
export interface ContentItemInput {
  sourceId: string;
  externalId: string;
  title: string;
  content: string | null;
  url: string;
  url_overridden_by_dest?: string;
  publishedAt: Date;
}

/**
 * Stored content item from the database.
 */
export interface StoredContentItem {
  id: string;
  sourceId: string;
  externalId: string;
  title: string;
  content: string | null;
  url: string;
  publishedAt: Date;
  fetchedAt: Date;
  isProcessed: boolean;
  processedAt: Date | null;
  postId: string | null;
  interestScore: number | null;
  interestReason: string | null;
}

/**
 * Options for fetch operations.
 */
export interface FetchOptions {
  /** Maximum number of items to fetch (default: 50) */
  maxItems?: number;
  /** Timeout for HTTP requests in milliseconds (default: 30000) */
  timeout?: number;
  /** Whether to skip duplicate detection (default: false) */
  skipDuplicateCheck?: boolean;
}

// ============================================
// CONSTANTS
// ============================================

/** Default maximum items to fetch per source */
export const DEFAULT_MAX_ITEMS = 50;

/** Default HTTP request timeout in milliseconds */
export const DEFAULT_TIMEOUT_MS = 30000;

/** Base delay for exponential backoff in milliseconds */
export const BASE_BACKOFF_DELAY_MS = 1000;

/** Maximum backoff delay in milliseconds (1 hour) */
export const MAX_BACKOFF_DELAY_MS = 3600000;

/** Maximum consecutive errors before disabling source */
export const MAX_CONSECUTIVE_ERRORS = 10;

/** Reddit API base URL */
const REDDIT_API_BASE = 'https://www.reddit.com';

/** User agent for HTTP requests */
const USER_AGENT = 'Synapsis Bot Content Fetcher/1.0';

// ============================================
// ERROR CLASSES
// ============================================

/**
 * Base error class for content fetching operations.
 */
export class ContentFetchError extends Error {
  constructor(
    message: string,
    public code: string,
    public sourceId?: string,
    public retryable: boolean = true
  ) {
    super(message);
    this.name = 'ContentFetchError';
  }
}

/**
 * Error thrown when a network request fails.
 */
export class NetworkError extends ContentFetchError {
  constructor(message: string, sourceId?: string) {
    super(message, 'NETWORK_ERROR', sourceId, true);
    this.name = 'NetworkError';
  }
}

/**
 * Error thrown when content parsing fails.
 */
export class ParseError extends ContentFetchError {
  constructor(message: string, sourceId?: string) {
    super(message, 'PARSE_ERROR', sourceId, false);
    this.name = 'ParseError';
  }
}

/**
 * Error thrown when source is not found.
 */
export class SourceNotFoundError extends ContentFetchError {
  constructor(sourceId: string) {
    super(`Content source not found: ${sourceId}`, 'SOURCE_NOT_FOUND', sourceId, false);
    this.name = 'SourceNotFoundError';
  }
}

// ============================================
// EXPONENTIAL BACKOFF
// ============================================

/**
 * Calculate the backoff delay based on consecutive errors.
 * Uses exponential backoff with jitter.
 * 
 * @param consecutiveErrors - Number of consecutive errors
 * @returns Delay in milliseconds
 * 
 * Validates: Requirements 4.7
 */
export function calculateBackoffDelay(consecutiveErrors: number): number {
  if (consecutiveErrors <= 0) {
    return 0;
  }
  
  // Exponential backoff: base * 2^(errors - 1)
  const exponentialDelay = BASE_BACKOFF_DELAY_MS * Math.pow(2, consecutiveErrors - 1);
  
  // Cap at maximum delay
  const cappedDelay = Math.min(exponentialDelay, MAX_BACKOFF_DELAY_MS);
  
  // Add jitter (±10% of the delay)
  const jitter = cappedDelay * 0.1 * (Math.random() * 2 - 1);
  
  return Math.floor(cappedDelay + jitter);
}

/**
 * Check if a source should be retried based on its error state.
 * 
 * @param source - The content source
 * @returns Whether the source should be retried
 */
export function shouldRetrySource(source: ContentSource): boolean {
  // Don't retry if source is inactive
  if (!source.isActive) {
    return false;
  }
  
  // Don't retry if max consecutive errors reached
  if (source.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    return false;
  }
  
  // Check if enough time has passed since last fetch
  if (source.lastFetchAt && source.consecutiveErrors > 0) {
    const backoffDelay = calculateBackoffDelay(source.consecutiveErrors);
    const timeSinceLastFetch = Date.now() - source.lastFetchAt.getTime();
    
    if (timeSinceLastFetch < backoffDelay) {
      return false;
    }
  }
  
  return true;
}

/**
 * Check if a source is due for fetching based on its interval.
 * 
 * @param source - The content source
 * @returns Whether the source is due for fetching
 */
export function isSourceDueForFetch(source: ContentSource): boolean {
  // Only check if source is active
  // Content is now fetched on-demand when posting, not on a schedule
  return source.isActive;
}

// ============================================
// HTTP FETCHING
// ============================================

/**
 * Fetch content from a URL with timeout.
 * 
 * @param url - The URL to fetch
 * @param options - Fetch options
 * @returns The response text
 * @throws NetworkError on failure
 */
async function fetchUrl(
  url: string,
  options: { timeout?: number; headers?: Record<string, string> } = {}
): Promise<string> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/rss+xml, application/xml, application/atom+xml, text/xml, application/json, */*',
        ...options.headers,
      },
    });
    
    if (!response.ok) {
      throw new NetworkError(
        `HTTP ${response.status}: ${response.statusText}`
      );
    }
    
    return await response.text();
  } catch (error) {
    if (error instanceof NetworkError) {
      throw error;
    }
    
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new NetworkError(`Request timeout after ${timeout}ms`);
      }
      throw new NetworkError(error.message);
    }
    
    throw new NetworkError('Unknown network error');
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================
// RSS FETCHING
// ============================================

/**
 * Fetch and parse an RSS feed.
 * 
 * @param url - The RSS feed URL
 * @param options - Fetch options
 * @returns Array of feed items
 * @throws NetworkError or ParseError on failure
 * 
 * Validates: Requirements 4.2
 */
export async function fetchRSSFeed(
  url: string,
  options: FetchOptions = {}
): Promise<FeedItem[]> {
  const xml = await fetchUrl(url, { timeout: options.timeout });
  
  const result = parseRSSFeed(xml);
  
  if (!result.success || !result.feed) {
    throw new ParseError(result.error || 'Failed to parse RSS feed');
  }
  
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  return result.feed.items.slice(0, maxItems);
}

// ============================================
// REDDIT FETCHING
// ============================================

/**
 * Fetch posts from a Reddit subreddit.
 * Uses the RSS feed which is more reliable than the JSON API.
 * 
 * @param subreddit - The subreddit name
 * @param options - Fetch options
 * @returns Array of feed items
 * @throws NetworkError or ParseError on failure
 * 
 * Validates: Requirements 4.3
 */
export async function fetchRedditPosts(
  subreddit: string,
  options: FetchOptions = {}
): Promise<FeedItem[]> {
  const requestedMaxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const fetchLimit = Math.min(Math.max(requestedMaxItems + 10, requestedMaxItems), 100);
  const url = new URL(`${REDDIT_API_BASE}/r/${subreddit}/hot.json`);
  url.searchParams.set('raw_json', '1');
  url.searchParams.set('limit', String(fetchLimit));

  const responseText = await fetchUrl(url.toString(), {
    timeout: options.timeout,
    headers: {
      'Accept': 'application/json',
    },
  });

  let response: RedditListingResponse;
  try {
    response = JSON.parse(responseText) as RedditListingResponse;
  } catch {
    throw new ParseError('Failed to parse Reddit JSON response');
  }

  const posts = response.data?.children
    ?.map((child) => child.data)
    .filter((post): post is RedditListingChildData => Boolean(post)) || [];

  const filteredPosts = posts.filter((post) => !shouldExcludeRedditPost(post));

  return filteredPosts.slice(0, requestedMaxItems).map((post): FeedItem => ({
    id: post.name || post.id,
    title: post.title,
    content: post.selftext || '',
    url: `${REDDIT_API_BASE}${post.permalink}`,
    publishedAt: new Date(post.created_utc * 1000),
  }));
}

// ============================================
// NEWS API FETCHING
// ============================================

/**
 * News API article structure.
 */
interface NewsApiArticle {
  source?: { id?: string; name?: string };
  title: string;
  description?: string;
  url: string;
  publishedAt: string;
  content?: string;
}

/**
 * News API response structure.
 */
interface NewsApiResponse {
  status: string;
  articles?: NewsApiArticle[];
  error?: string;
}

/**
 * Brave News API result structure.
 */
interface BraveNewsResult {
  title: string;
  url: string;
  description?: string;
  age?: string;
  page_age?: string;
  meta_url?: {
    hostname?: string;
  };
}

/**
 * Brave News API response structure.
 */
interface BraveNewsResponse {
  type: string;
  results?: BraveNewsResult[];
}

interface RedditListingChildData {
  id: string;
  name?: string;
  title: string;
  selftext?: string;
  permalink: string;
  url: string;
  url_overridden_by_dest?: string;
  created_utc: number;
  stickied?: boolean;
  pinned?: boolean;
}

interface RedditListingResponse {
  data?: {
    children?: Array<{
      data?: RedditListingChildData;
    }>;
  };
}

export function shouldExcludeRedditPost(post: RedditListingChildData): boolean {
  return Boolean(post.stickied || post.pinned);
}

/**
 * Fetch articles from a news API.
 * 
 * @param url - The news API URL
 * @param apiKey - The API key for authentication
 * @param options - Fetch options
 * @returns Array of feed items
 * @throws NetworkError or ParseError on failure
 * 
 * Validates: Requirements 4.4
 */
export async function fetchNewsApi(
  url: string,
  apiKey: string,
  options: FetchOptions = {}
): Promise<FeedItem[]> {
  // Append API key to URL if not already present
  const urlObj = new URL(url);
  if (!urlObj.searchParams.has('apiKey') && !urlObj.searchParams.has('api_key')) {
    urlObj.searchParams.set('apiKey', apiKey);
  }
  
  const responseText = await fetchUrl(urlObj.toString(), {
    timeout: options.timeout,
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
  });
  
  let response: NewsApiResponse;
  try {
    response = JSON.parse(responseText);
  } catch {
    throw new ParseError('Failed to parse News API JSON response');
  }
  
  if (response.status !== 'ok' || !response.articles) {
    throw new ParseError(response.error || 'Invalid News API response');
  }
  
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  
  return response.articles.slice(0, maxItems).map((article, index): FeedItem => ({
    id: `${article.source?.id || 'news'}-${index}-${Date.now()}`,
    title: article.title,
    content: article.description || article.content || '',
    url: article.url,
    publishedAt: new Date(article.publishedAt),
  }));
}

/**
 * Fetch articles from Brave News Search API.
 * 
 * @param config - The Brave News configuration
 * @param apiKey - The API key for authentication
 * @param options - Fetch options
 * @returns Array of feed items
 * @throws NetworkError or ParseError on failure
 */
export async function fetchBraveNews(
  config: BraveNewsConfig,
  apiKey: string,
  options: FetchOptions = {}
): Promise<FeedItem[]> {
  // Build the URL from config
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
  
  const count = Math.min(config.count || 20, 50);
  url.searchParams.set('count', String(count));
  
  const responseText = await fetchUrl(url.toString(), {
    timeout: options.timeout,
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': apiKey,
    },
  });
  
  let response: BraveNewsResponse;
  try {
    response = JSON.parse(responseText);
  } catch {
    throw new ParseError('Failed to parse Brave News API JSON response');
  }
  
  if (!response.results || response.results.length === 0) {
    return [];
  }
  
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  
  return response.results.slice(0, maxItems).map((result, index): FeedItem => ({
    id: `brave-${config.query.replace(/\s+/g, '-')}-${index}-${Date.now()}`,
    title: result.title,
    content: result.description || '',
    url: result.url,
    publishedAt: new Date(), // Brave doesn't always provide exact dates
  }));
}

// ============================================
// CONTENT STORAGE
// ============================================

/**
 * Check if a content item already exists in the database.
 * 
 * @param sourceId - The source ID
 * @param externalId - The external ID from the source
 * @returns True if the item exists
 */
export async function contentItemExists(
  sourceId: string,
  externalId: string
): Promise<boolean> {
  const existing = await db.query.botContentItems.findFirst({
    where: and(
      eq(botContentItems.sourceId, sourceId),
      eq(botContentItems.externalId, externalId)
    ),
    columns: { id: true },
  });
  
  return existing !== undefined;
}

/**
 * Store a content item in the database.
 * 
 * @param item - The content item to store
 * @returns The stored content item
 * 
 * Validates: Requirements 4.5
 */
export async function storeContentItem(
  item: ContentItemInput
): Promise<StoredContentItem> {
  const [stored] = await db
    .insert(botContentItems)
    .values({
      sourceId: item.sourceId,
      externalId: item.externalId,
      title: item.title,
      content: item.content,
      url: item.url,
      publishedAt: item.publishedAt,
      isProcessed: false,
    })
    .returning();
  
  return {
    id: stored.id,
    sourceId: stored.sourceId,
    externalId: stored.externalId,
    title: stored.title,
    content: stored.content,
    url: stored.url,
    publishedAt: stored.publishedAt,
    fetchedAt: stored.fetchedAt,
    isProcessed: stored.isProcessed,
    processedAt: stored.processedAt,
    postId: stored.postId,
    interestScore: stored.interestScore,
    interestReason: stored.interestReason,
  };
}

/**
 * Store multiple content items, skipping duplicates.
 * 
 * @param items - The content items to store
 * @param skipDuplicateCheck - Whether to skip duplicate checking
 * @returns Number of items stored
 * 
 * Validates: Requirements 4.5
 */
export async function storeContentItems(
  items: ContentItemInput[],
  skipDuplicateCheck: boolean = false
): Promise<number> {
  let storedCount = 0;
  
  for (const item of items) {
    // Check for duplicates unless skipped
    if (!skipDuplicateCheck) {
      const exists = await contentItemExists(item.sourceId, item.externalId);
      if (exists) {
        continue;
      }
    }
    
    try {
      await storeContentItem(item);
      storedCount++;
    } catch (error) {
      // Skip items that fail to store (e.g., constraint violations)
      console.error(`Failed to store content item: ${error}`);
    }
  }
  
  return storedCount;
}

// ============================================
// SOURCE STATE MANAGEMENT
// ============================================

/**
 * Update source state after a successful fetch.
 * 
 * @param sourceId - The source ID
 */
export async function recordFetchSuccess(sourceId: string): Promise<void> {
  await db
    .update(botContentSources)
    .set({
      lastFetchAt: new Date(),
      lastError: null,
      consecutiveErrors: 0,
      updatedAt: new Date(),
    })
    .where(eq(botContentSources.id, sourceId));
}

/**
 * Update source state after a failed fetch.
 * 
 * @param sourceId - The source ID
 * @param error - The error message
 * 
 * Validates: Requirements 4.7
 */
export async function recordFetchError(
  sourceId: string,
  error: string
): Promise<void> {
  // Get current consecutive errors
  const source = await db.query.botContentSources.findFirst({
    where: eq(botContentSources.id, sourceId),
    columns: { consecutiveErrors: true },
  });
  
  const currentErrors = source?.consecutiveErrors ?? 0;
  const newErrors = currentErrors + 1;
  
  // Disable source if max errors reached
  const shouldDisable = newErrors >= MAX_CONSECUTIVE_ERRORS;
  
  await db
    .update(botContentSources)
    .set({
      lastFetchAt: new Date(),
      lastError: error,
      consecutiveErrors: newErrors,
      isActive: shouldDisable ? false : undefined,
      updatedAt: new Date(),
    })
    .where(eq(botContentSources.id, sourceId));
}

// ============================================
// MAIN FETCH FUNCTION
// ============================================

/**
 * Fetch content from a source and store new items.
 * Implements exponential backoff on failures.
 * 
 * @param sourceId - The ID of the content source
 * @param options - Fetch options
 * @returns Fetch result with statistics
 * 
 * Validates: Requirements 4.5, 4.7
 */
export async function fetchContent(
  sourceId: string,
  options: FetchOptions = {}
): Promise<FetchResult> {
  const warnings: string[] = [];
  
  // Get the source
  const source = await getSourceById(sourceId);
  
  if (!source) {
    throw new SourceNotFoundError(sourceId);
  }
  
  // Check if source should be retried
  if (!shouldRetrySource(source)) {
    return {
      success: false,
      sourceId,
      itemsFetched: 0,
      itemsStored: 0,
      error: source.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS
        ? 'Source disabled due to too many consecutive errors'
        : 'Source is in backoff period',
      warnings,
    };
  }
  
  try {
    let items: FeedItem[];
    
    // Fetch based on source type
    switch (source.type) {
      case 'rss':
      case 'youtube':
        // YouTube channels/playlists use RSS feeds
        items = await fetchRSSFeed(source.url, options);
        break;
        
      case 'reddit':
        if (!source.subreddit) {
          throw new ParseError('Reddit source missing subreddit');
        }
        items = await fetchRedditPosts(source.subreddit, options);
        break;
        
      case 'news_api':
        // Decrypt API key
        const dbSource = await db.query.botContentSources.findFirst({
          where: eq(botContentSources.id, sourceId),
          columns: { apiKeyEncrypted: true },
        });
        
        if (!dbSource?.apiKeyEncrypted) {
          throw new ParseError('News API source missing API key');
        }
        
        const encryptedData = deserializeEncryptedData(dbSource.apiKeyEncrypted);
        const apiKey = decryptApiKey(encryptedData);
        
        items = await fetchNewsApi(source.url, apiKey, options);
        break;
        
      case 'brave_news':
        // Decrypt API key
        const braveDbSource = await db.query.botContentSources.findFirst({
          where: eq(botContentSources.id, sourceId),
          columns: { apiKeyEncrypted: true, sourceConfig: true },
        });
        
        if (!braveDbSource?.apiKeyEncrypted) {
          throw new ParseError('Brave News source missing API key');
        }
        
        const braveEncryptedData = deserializeEncryptedData(braveDbSource.apiKeyEncrypted);
        const braveApiKey = decryptApiKey(braveEncryptedData);
        
        // Get config from sourceConfig or parse from URL
        let braveConfig: BraveNewsConfig;
        if (braveDbSource.sourceConfig) {
          braveConfig = JSON.parse(braveDbSource.sourceConfig) as BraveNewsConfig;
        } else {
          // Fallback: extract query from URL
          const urlObj = new URL(source.url);
          braveConfig = {
            query: urlObj.searchParams.get('q') || 'news',
            freshness: (urlObj.searchParams.get('freshness') as BraveNewsConfig['freshness']) || undefined,
            country: urlObj.searchParams.get('country') || undefined,
            searchLang: urlObj.searchParams.get('search_lang') || undefined,
          };
        }
        
        items = await fetchBraveNews(braveConfig, braveApiKey, options);
        break;
        
      default:
        throw new ParseError(`Unsupported source type: ${source.type}`);
    }
    
    // Filter by keywords if configured
    if (source.keywords && source.keywords.length > 0) {
      const keywords = source.keywords.map(k => k.toLowerCase());
      items = items.filter(item => {
        const text = `${item.title} ${item.content}`.toLowerCase();
        return keywords.some(keyword => text.includes(keyword));
      });
    }
    
    // Convert to content items
    const contentItems: ContentItemInput[] = items.map(item => ({
      sourceId,
      externalId: item.id,
      title: item.title,
      content: item.content,
      url: item.url,
      publishedAt: item.publishedAt,
    }));
    
    // Store items
    const storedCount = await storeContentItems(
      contentItems,
      options.skipDuplicateCheck
    );
    
    // Record success
    await recordFetchSuccess(sourceId);
    
    return {
      success: true,
      sourceId,
      itemsFetched: items.length,
      itemsStored: storedCount,
      warnings,
    };
  } catch (error) {
    // Record error
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await recordFetchError(sourceId, errorMessage);
    
    return {
      success: false,
      sourceId,
      itemsFetched: 0,
      itemsStored: 0,
      error: errorMessage,
      warnings,
    };
  }
}

/**
 * Fetch content from a source with retry logic.
 * Retries on retryable errors with exponential backoff.
 * 
 * @param sourceId - The ID of the content source
 * @param maxRetries - Maximum number of retries (default: 3)
 * @param options - Fetch options
 * @returns Fetch result
 * 
 * Validates: Requirements 4.7
 */
export async function fetchContentWithRetry(
  sourceId: string,
  maxRetries: number = 3,
  options: FetchOptions = {}
): Promise<FetchResult> {
  let lastResult: FetchResult | null = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Wait for backoff delay on retries
    if (attempt > 0) {
      const delay = calculateBackoffDelay(attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    try {
      const result = await fetchContent(sourceId, options);
      
      if (result.success) {
        return result;
      }
      
      lastResult = result;
      
      // Don't retry if error is not retryable
      if (result.error?.includes('disabled') || result.error?.includes('backoff')) {
        return result;
      }
    } catch (error) {
      if (error instanceof ContentFetchError && !error.retryable) {
        throw error;
      }
      
      lastResult = {
        success: false,
        sourceId,
        itemsFetched: 0,
        itemsStored: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
        warnings: [],
      };
    }
  }
  
  return lastResult || {
    success: false,
    sourceId,
    itemsFetched: 0,
    itemsStored: 0,
    error: 'Max retries exceeded',
    warnings: [],
  };
}

/**
 * Fetch content from all active sources for a bot.
 * 
 * @param botId - The bot ID
 * @param options - Fetch options
 * @returns Array of fetch results
 */
export async function fetchAllSourcesForBot(
  botId: string,
  options: FetchOptions = {}
): Promise<FetchResult[]> {
  const sources = await db.query.botContentSources.findMany({
    where: and(
      eq(botContentSources.botId, botId),
      eq(botContentSources.isActive, true)
    ),
  });
  
  const results: FetchResult[] = [];
  
  for (const source of sources) {
    // Check if source is due for fetching
    const sourceObj: ContentSource = {
      id: source.id,
      botId: source.botId,
      type: source.type as ContentSourceType,
      url: source.url,
      subreddit: source.subreddit,
      keywords: source.keywords ? JSON.parse(source.keywords) : null,
      sourceConfig: source.sourceConfig ? JSON.parse(source.sourceConfig) : null,
      isActive: source.isActive,
      lastFetchAt: source.lastFetchAt,
      lastError: source.lastError,
      consecutiveErrors: source.consecutiveErrors,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    };
    
    if (!isSourceDueForFetch(sourceObj)) {
      continue;
    }
    
    const result = await fetchContentWithRetry(source.id, 3, options);
    results.push(result);
  }
  
  return results;
}

/**
 * Get unprocessed content items for a source.
 * 
 * @param sourceId - The source ID
 * @param limit - Maximum number of items to return
 * @returns Array of unprocessed content items
 */
export async function getUnprocessedItems(
  sourceId: string,
  limit: number = 10
): Promise<StoredContentItem[]> {
  const items = await db.query.botContentItems.findMany({
    where: and(
      eq(botContentItems.sourceId, sourceId),
      eq(botContentItems.isProcessed, false)
    ),
    orderBy: (items, { asc }) => [asc(items.publishedAt)],
    limit,
  });
  
  return items.map(item => ({
    id: item.id,
    sourceId: item.sourceId,
    externalId: item.externalId,
    title: item.title,
    content: item.content,
    url: item.url,
    publishedAt: item.publishedAt,
    fetchedAt: item.fetchedAt,
    isProcessed: item.isProcessed,
    processedAt: item.processedAt,
    postId: item.postId,
    interestScore: item.interestScore,
    interestReason: item.interestReason,
  }));
}

/**
 * Mark a content item as processed.
 * 
 * @param itemId - The content item ID
 * @param postId - Optional post ID if a post was created
 */
export async function markItemProcessed(
  itemId: string,
  postId?: string
): Promise<void> {
  await db
    .update(botContentItems)
    .set({
      isProcessed: true,
      processedAt: new Date(),
      postId: postId || null,
    })
    .where(eq(botContentItems.id, itemId));
}
