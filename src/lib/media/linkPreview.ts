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
