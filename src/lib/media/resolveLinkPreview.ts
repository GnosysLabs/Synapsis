import type { LinkPreviewData } from './linkPreview';
import { fetchGenericLinkPreview } from './genericPreview';
import { fetchRedditRichPreview } from './redditPreview';
import { buildVideoLinkPreview } from './video-embed';

function isRedditUrl(url: string): boolean {
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname === 'reddit.com'
    || hostname.endsWith('.reddit.com')
    || hostname === 'redd.it'
    || hostname.endsWith('.redd.it');
}

function fallbackTitle(url: string): string {
  return new URL(url).hostname.replace(/^www\./, '');
}

export async function resolveLinkPreview(url: string): Promise<LinkPreviewData> {
  const videoPreview = buildVideoLinkPreview(url);
  if (videoPreview) return videoPreview;

  if (isRedditUrl(url)) {
    const redditPreview = await fetchRedditRichPreview(url);
    if (redditPreview) return redditPreview;
  }

  const genericPreview = await fetchGenericLinkPreview(url);
  if (genericPreview) {
    return {
      ...genericPreview,
      title: genericPreview.title?.trim() || fallbackTitle(url),
      description: genericPreview.description?.trim() || null,
      image: genericPreview.image?.trim() || null,
    };
  }

  return {
    url,
    title: fallbackTitle(url),
    description: null,
    image: null,
    type: 'card',
    videoUrl: null,
    media: null,
  };
}
