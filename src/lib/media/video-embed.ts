import type { LinkPreviewData } from './linkPreview';

export type VideoEmbedProvider = 'YouTube' | 'Vimeo';

export interface ParsedVideoEmbed {
  provider: VideoEmbedProvider;
  sourceUrl: string;
  embedUrl: string;
}

const YOUTUBE_VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;
const VIMEO_VIDEO_ID = /^\d{1,20}$/;
const VIDEO_URL_CANDIDATE = /https:\/\/[^\s<>"']+|(?:www\.)?(?:youtu\.be|youtube\.com|youtube-nocookie\.com|vimeo\.com|player\.vimeo\.com)\/[^\s<>"']+/gi;
const BARE_URL_LEADING_CHARACTER = /[a-zA-Z0-9_@./-]/;

function trimUrlEnd(value: string): string {
  let result = value;
  while (/[.,!?;:\u2019\u201d]$/.test(result)) result = result.slice(0, -1);

  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ];
  for (const [open, close] of pairs) {
    while (result.endsWith(close)) {
      const opens = result.split(open).length - 1;
      const closes = result.split(close).length - 1;
      if (closes <= opens) break;
      result = result.slice(0, -1);
    }
  }

  return result;
}

function normalizeVideoUrl(value: string): URL | null {
  const trimmed = trimUrlEnd(value.trim());
  if (!trimmed) return null;

  const absolute = trimmed.startsWith('https://')
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(absolute);
    return parsed.protocol === 'https:'
      && !parsed.username
      && !parsed.password
      && !parsed.port
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function parseVideoEmbedUrl(value: string): ParsedVideoEmbed | null {
  const parsed = normalizeVideoUrl(value);
  if (!parsed) return null;

  const hostname = parsed.hostname.toLowerCase();
  const pathParts = parsed.pathname.split('/').filter(Boolean);
  const sourceUrl = parsed.toString();

  const youtubeHost = hostname === 'youtube.com'
    || hostname === 'www.youtube.com'
    || hostname === 'm.youtube.com'
    || hostname === 'music.youtube.com'
    || hostname === 'youtu.be'
    || hostname === 'youtube-nocookie.com'
    || hostname === 'www.youtube-nocookie.com';
  if (youtubeHost) {
    const youtubeNoCookie = hostname === 'youtube-nocookie.com'
      || hostname === 'www.youtube-nocookie.com';
    let candidate: string | null = null;
    if (hostname === 'youtu.be' && pathParts.length === 1) {
      candidate = pathParts[0];
    } else if (!youtubeNoCookie && pathParts.length === 1 && pathParts[0] === 'watch') {
      candidate = parsed.searchParams.get('v');
    } else if (pathParts.length === 2
      && ['embed', 'shorts', 'live', 'v'].includes(pathParts[0])
      && (!youtubeNoCookie || pathParts[0] === 'embed')) {
      candidate = pathParts[1];
    }
    if (candidate && YOUTUBE_VIDEO_ID.test(candidate)) {
      return {
        provider: 'YouTube',
        sourceUrl,
        embedUrl: `https://www.youtube-nocookie.com/embed/${candidate}`,
      };
    }
  }

  if (hostname === 'vimeo.com'
    || hostname === 'www.vimeo.com'
    || hostname === 'player.vimeo.com') {
    const videoId = hostname === 'player.vimeo.com'
      ? pathParts.length === 2 && pathParts[0] === 'video' ? pathParts[1] : null
      : pathParts.length === 1 ? pathParts[0] : null;
    if (videoId) {
      if (!VIMEO_VIDEO_ID.test(videoId)) return null;
      return {
        provider: 'Vimeo',
        sourceUrl,
        embedUrl: `https://player.vimeo.com/video/${videoId}`,
      };
    }
  }

  return null;
}

/** Find the first strictly recognized video-provider URL without making a request. */
export function findVideoEmbedUrlInText(value: string): string | null {
  const visibleText = value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'");
  VIDEO_URL_CANDIDATE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = VIDEO_URL_CANDIDATE.exec(visibleText)) !== null) {
    const candidate = match[0];
    if (!candidate.startsWith('https://')) {
      const previous = match.index > 0 ? visibleText[match.index - 1] : '';
      if (previous && BARE_URL_LEADING_CHARACTER.test(previous)) continue;
    }

    const parsed = parseVideoEmbedUrl(candidate);
    if (parsed) return parsed.sourceUrl;
  }

  return null;
}

export function buildVideoLinkPreview(value: string): LinkPreviewData | null {
  const parsed = parseVideoEmbedUrl(value);
  if (!parsed) return null;

  return {
    url: parsed.sourceUrl,
    title: parsed.provider,
    description: null,
    image: null,
    type: 'video',
    videoUrl: null,
    media: null,
  };
}
