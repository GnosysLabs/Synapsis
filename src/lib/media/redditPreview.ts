import type { LinkPreviewData } from './linkPreview';
import { safeFederationRequest } from '@/lib/swarm/safe-federation-http';

interface RedditOEmbedResponse {
  title?: string;
  author_name?: string;
  provider_name?: string;
  thumbnail_url?: string;
  html?: string;
}

function extractTitleFromHtml(html?: string): string | null {
  if (!html) return null;
  const titleMatch = html.match(/href="[^"]+">([^<]+)<\/a>/);
  if (titleMatch?.[1] && titleMatch[1] !== 'Comment') {
    return titleMatch[1];
  }
  return null;
}

function extractSubredditFromHtml(html?: string): string | null {
  if (!html) return null;
  const subredditMatch = html.match(/r\/([a-zA-Z0-9_]+)/);
  return subredditMatch?.[1] || null;
}

export async function fetchRedditRichPreview(url: string): Promise<LinkPreviewData | null> {
  try {
    const oembedUrl = `https://www.reddit.com/oembed?url=${encodeURIComponent(url)}`;
    const response = await safeFederationRequest(oembedUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Synapsis Link Preview/1.0',
      },
      timeoutMs: 5_000,
      maxResponseBytes: 128 * 1024,
    });

    if (response.status < 200 || response.status >= 300) {
      return null;
    }

    const data = response.json() as RedditOEmbedResponse;
    const title = (data.title || extractTitleFromHtml(data.html) || 'Reddit').slice(0, 300);
    const subreddit = extractSubredditFromHtml(data.html);
    const description = data.author_name
      ? `Posted by ${data.author_name.slice(0, 100)}${subreddit ? ` in r/${subreddit}` : ''}`
      : subreddit
        ? `r/${subreddit}`
        : (data.provider_name || 'Reddit');

    return {
      url,
      title,
      description,
      image: null,
      type: 'card',
      videoUrl: null,
      media: null,
    };
  } catch {
    return null;
  }
}
