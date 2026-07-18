export interface AudioArtwork {
  data: Uint8Array;
  mimeType: string;
}

export interface AudioTrackMetadata {
  title?: string;
  artist?: string;
  album?: string;
  artwork?: AudioArtwork;
}

interface CommonAudioMetadata {
  title?: string;
  artist?: string;
  artists?: string[];
  albumartist?: string;
  album?: string;
  picture?: Array<{
    data: Uint8Array;
    format: string;
    type?: string;
  }>;
}

const metadataRequests = new Map<string, Promise<AudioTrackMetadata | null>>();
const MAX_CACHED_REQUESTS = 64;

function clean(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function artworkMimeType(format: string): string {
  const normalized = format.trim().toLowerCase();
  if (normalized.includes('/')) return normalized;
  if (normalized === 'jpg' || normalized === 'jpeg') return 'image/jpeg';
  if (normalized === 'svg') return 'image/svg+xml';
  return `image/${normalized || 'jpeg'}`;
}

export function normalizeAudioMetadata(common: CommonAudioMetadata): AudioTrackMetadata | null {
  const picture = common.picture?.find((candidate) =>
    candidate.type?.toLowerCase().includes('front')
  ) ?? common.picture?.[0];
  const artist = clean(common.artist)
    ?? clean(common.artists?.join(', '))
    ?? clean(common.albumartist);
  const metadata: AudioTrackMetadata = {
    title: clean(common.title),
    artist,
    album: clean(common.album),
    artwork: picture ? {
      data: picture.data,
      mimeType: artworkMimeType(picture.format),
    } : undefined,
  };

  return metadata.title || metadata.artist || metadata.album || metadata.artwork
    ? metadata
    : null;
}

async function fetchAudioMetadata(src: string): Promise<AudioTrackMetadata | null> {
  const response = await fetch(src);
  if (!response.ok || !response.body) return null;

  const contentLength = Number(response.headers.get('content-length'));
  const contentType = response.headers.get('content-type') || undefined;
  const path = (() => {
    try {
      return new URL(src, window.location.href).pathname;
    } catch {
      return undefined;
    }
  })();
  const { parseWebStream } = await import('music-metadata');
  const parsed = await parseWebStream(response.body, {
    mimeType: contentType,
    size: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined,
    path,
  }, { duration: false });

  return normalizeAudioMetadata(parsed.common);
}

export function loadAudioMetadata(src: string): Promise<AudioTrackMetadata | null> {
  const existing = metadataRequests.get(src);
  if (existing) return existing;

  const request = fetchAudioMetadata(src).catch(() => null);
  metadataRequests.set(src, request);

  if (metadataRequests.size > MAX_CACHED_REQUESTS) {
    const oldest = metadataRequests.keys().next().value;
    if (oldest) metadataRequests.delete(oldest);
  }

  return request;
}
