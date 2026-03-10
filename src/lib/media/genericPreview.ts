import type { LinkPreviewData } from './linkPreview';

const GENERIC_PREVIEW_USER_AGENT = 'Mozilla/5.0 (compatible; SynapsisBot/1.0; +https://synapsis.social)';

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractMeta(html: string, property: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name|itemprop)=["'](?:og:|twitter:)?${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name|itemprop)=["'](?:og:|twitter:)?${property}["']`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return decodeHtmlEntities(match[1]);
    }
  }

  return null;
}

export async function fetchGenericLinkPreview(url: string): Promise<LinkPreviewData | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': GENERIC_PREVIEW_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    const title = extractMeta(html, 'title') || html.match(/<title>([^<]+)<\/title>/i)?.[1] || null;
    const description = extractMeta(html, 'description');
    const image = extractMeta(html, 'image');

    return {
      url,
      title: title?.trim() || null,
      description: description?.trim() || null,
      image: image?.trim() || null,
      type: image?.trim() ? 'image' : 'card',
      videoUrl: null,
      media: image?.trim() ? [{ url: image.trim() }] : null,
    };
  } catch {
    return null;
  }
}
