import type { ContentSourceConfig } from './contentSource';
import { ContentSourceValidationError, validateContentSourceConfig } from './contentSource';
import { fetchRSSFeed, fetchRedditPosts, fetchNewsApi, fetchBraveNews, NetworkError, ParseError } from './contentFetcher';
import type { FeedItem } from './rssParser';

const VALIDATION_TIMEOUT_MS = 10000;

export async function validateSourceReachability(config: ContentSourceConfig): Promise<void> {
  const validation = validateContentSourceConfig(config);
  if (!validation.valid) {
    throw new ContentSourceValidationError(
      `Invalid content source configuration: ${validation.errors.join(', ')}`,
      validation.errors
    );
  }

  try {
    let items: FeedItem[] = [];

    switch (config.type) {
      case 'rss':
      case 'youtube':
        items = await fetchRSSFeed(config.url, { maxItems: 1, timeout: VALIDATION_TIMEOUT_MS });
        break;

      case 'reddit':
        items = await fetchRedditPosts(
          config.subreddit || '',
          { maxItems: 1, timeout: VALIDATION_TIMEOUT_MS }
        );
        break;

      case 'news_api':
        items = await fetchNewsApi(
          config.url,
          config.apiKey || '',
          { maxItems: 1, timeout: VALIDATION_TIMEOUT_MS }
        );
        break;

      case 'brave_news':
        items = await fetchBraveNews(
          config.braveNewsConfig || { query: '' },
          config.apiKey || '',
          { maxItems: 1, timeout: VALIDATION_TIMEOUT_MS }
        );
        break;

      default:
        items = [];
    }

    if (!items || items.length === 0) {
      throw new ContentSourceValidationError(
        'Source is reachable but returned no items',
        ['Source is reachable but returned no items']
      );
    }
  } catch (error) {
    if (error instanceof ContentSourceValidationError) {
      throw error;
    }

    if (error instanceof NetworkError || error instanceof ParseError) {
      throw new ContentSourceValidationError(
        `Could not validate source: ${error.message}`,
        [error.message]
      );
    }

    if (error instanceof Error) {
      throw new ContentSourceValidationError(
        `Could not validate source: ${error.message}`,
        [error.message]
      );
    }

    throw new ContentSourceValidationError(
      'Could not validate source',
      ['Could not validate source']
    );
  }
}
