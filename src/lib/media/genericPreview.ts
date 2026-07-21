import type { LinkPreviewData } from './linkPreview';
import { isPublicSwarmDomain } from '@/lib/swarm/node-domain';
import { safeFederationRequest } from '@/lib/swarm/safe-federation-http';

const GENERIC_PREVIEW_USER_AGENT = 'Mozilla/5.0 (compatible; SynapsisPreview/1.0; +https://synapsis.social)';
const HTML_CONTENT_TYPE = /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i;
const MAX_PREVIEW_RESPONSE_BYTES = 128 * 1024;

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

function bounded(value: string | null, maximum: number): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, maximum) : null;
}

function safePublicImageUrl(value: string | null, pageUrl: string): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value, pageUrl);
    if (parsed.protocol !== 'https:' || !isPublicSwarmDomain(parsed.hostname)) return null;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

export async function fetchGenericLinkPreview(url: string): Promise<LinkPreviewData | null> {
  try {
    const response = await safeFederationRequest(url, {
      headers: {
        'User-Agent': GENERIC_PREVIEW_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeoutMs: 5_000,
      maxResponseBytes: MAX_PREVIEW_RESPONSE_BYTES,
      truncateResponse: true,
    });

    if (response.status < 200 || response.status >= 300) return null;
    const contentTypeValue = response.headers['content-type'];
    const contentType = Array.isArray(contentTypeValue) ? contentTypeValue[0] : contentTypeValue;
    if (!contentType || !HTML_CONTENT_TYPE.test(contentType)) return null;

    const html = await response.text();
    const title = bounded(
      extractMeta(html, 'title') || html.match(/<title>([^<]+)<\/title>/i)?.[1] || null,
      300,
    );
    const description = bounded(extractMeta(html, 'description'), 1_000);
    const image = safePublicImageUrl(extractMeta(html, 'image'), url);

    return {
      url,
      title,
      description,
      image,
      type: image ? 'image' : 'card',
      videoUrl: null,
      media: image ? [{ url: image }] : null,
    };
  } catch {
    return null;
  }
}
