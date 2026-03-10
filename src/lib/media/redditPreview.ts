import type { LinkPreviewData } from './linkPreview';

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
    const response = await fetch(oembedUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Synapsis Link Preview/1.0',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as RedditOEmbedResponse;
    const title = data.title || extractTitleFromHtml(data.html) || 'Reddit';
    const subreddit = extractSubredditFromHtml(data.html);
    const description = data.author_name
      ? `Posted by ${data.author_name}${subreddit ? ` in r/${subreddit}` : ''}`
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
