import { parseMentions } from '@/lib/mentions/parser';

export type LinkPreviewType = 'card' | 'image' | 'gallery' | 'video';

export interface LinkPreviewMediaItem {
  url: string;
  width?: number | null;
  height?: number | null;
  mimeType?: string | null;
}

export interface LinkPreviewData {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  type?: LinkPreviewType | null;
  videoUrl?: string | null;
  media?: LinkPreviewMediaItem[] | null;
}

const LINK_CANDIDATE = /(?:https?:\/\/)?((?:[a-zA-Z0-9-]+\.)+[a-z]{2,63})\b([-a-zA-Z0-9@:%_+.~#?&//=()]*)/gi;
const TRAILING_LINK_PUNCTUATION = /[\])},.!?;:'"]+$/;

export function findLinkPreviewUrlInText(value: string): string | null {
  const mentionRanges = parseMentions(value);
  for (const match of value.matchAll(LINK_CANDIDATE)) {
    const start = match.index ?? 0;
    const raw = match[0].replace(TRAILING_LINK_PUNCTUATION, '');
    const end = start + raw.length;
    if (!raw || mentionRanges.some((mention) => start < mention.end && end > mention.start)) {
      continue;
    }

    try {
      const parsed = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) continue;
      return parsed.toString();
    } catch {
      continue;
    }
  }
  return null;
}

export function proxiedLinkPreviewImageUrl(value: string): string {
  if (value.startsWith('/')) return value;
  return `/api/media/preview/image?url=${encodeURIComponent(value)}`;
}

export function parseLinkPreviewMediaJson(
  value?: string | null
): LinkPreviewMediaItem[] | undefined {
  if (!value) return undefined;

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;

    return parsed.filter((item): item is LinkPreviewMediaItem => (
      item &&
      typeof item === 'object' &&
      typeof item.url === 'string'
    ));
  } catch {
    return undefined;
  }
}

export function serializeLinkPreviewMedia(
  media?: LinkPreviewMediaItem[] | null
): string | null {
  if (!media || media.length === 0) return null;
  return JSON.stringify(media);
}
