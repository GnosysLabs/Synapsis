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
const MAX_AUDIO_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_AUDIO_ARTWORK_BYTES = 1024 * 1024;
const AUDIO_METADATA_TIMEOUT_MS = 8_000;
const MAX_CONCURRENT_METADATA_REQUESTS = 2;
let activeMetadataRequests = 0;
const metadataWaiters: Array<() => void> = [];

function clean(value: string | undefined): string | undefined {
  const normalized = value?.trim().slice(0, 300);
  return normalized || undefined;
}

function artworkMimeType(format: string): string | null {
  const normalized = format.trim().toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/png' || normalized === 'image/webp') {
    return normalized;
  }
  if (normalized === 'jpg' || normalized === 'jpeg') return 'image/jpeg';
  if (normalized === 'png') return 'image/png';
  if (normalized === 'webp') return 'image/webp';
  return null;
}

export function normalizeAudioMetadata(common: CommonAudioMetadata): AudioTrackMetadata | null {
  const picture = common.picture?.find((candidate) =>
    candidate.type?.toLowerCase().includes('front')
  ) ?? common.picture?.[0];
  const artist = clean(common.artist)
    ?? clean(common.artists?.join(', '))
    ?? clean(common.albumartist);
  const pictureMimeType = picture ? artworkMimeType(picture.format) : null;
  const metadata: AudioTrackMetadata = {
    title: clean(common.title),
    artist,
    album: clean(common.album),
    artwork: picture && pictureMimeType && picture.data.byteLength <= MAX_AUDIO_ARTWORK_BYTES ? {
      data: picture.data,
      mimeType: pictureMimeType,
    } : undefined,
  };

  return metadata.title || metadata.artist || metadata.album || metadata.artwork
    ? metadata
    : null;
}

async function fetchAudioMetadata(src: string): Promise<AudioTrackMetadata | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), AUDIO_METADATA_TIMEOUT_MS);
  const response = await fetch(src, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal: controller.signal,
  });
  if (!response.ok || !response.body) {
    window.clearTimeout(timeout);
    controller.abort();
    return null;
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_AUDIO_METADATA_BYTES) {
    window.clearTimeout(timeout);
    controller.abort();
    return null;
  }
  const contentType = response.headers.get('content-type') || undefined;
  const path = (() => {
    try {
      return new URL(src, window.location.href).pathname;
    } catch {
      return undefined;
    }
  })();
  const { parseWebStream } = await import('music-metadata');
  let receivedBytes = 0;
  const boundedStream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, streamController) {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > MAX_AUDIO_METADATA_BYTES) {
        controller.abort();
        streamController.error(new Error('Audio metadata scan exceeded its byte limit'));
        return;
      }
      streamController.enqueue(chunk);
    },
  }));
  try {
    const parsed = await parseWebStream(boundedStream, {
      mimeType: contentType,
      size: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined,
      path,
    }, { duration: false });
    return normalizeAudioMetadata(parsed.common);
  } finally {
    window.clearTimeout(timeout);
    controller.abort();
  }
}

async function withMetadataSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeMetadataRequests >= MAX_CONCURRENT_METADATA_REQUESTS) {
    await new Promise<void>((resolve) => metadataWaiters.push(resolve));
  }
  activeMetadataRequests += 1;
  try {
    return await work();
  } finally {
    activeMetadataRequests -= 1;
    metadataWaiters.shift()?.();
  }
}

export function loadAudioMetadata(src: string): Promise<AudioTrackMetadata | null> {
  const existing = metadataRequests.get(src);
  if (existing) return existing;

  const request = withMetadataSlot(() => fetchAudioMetadata(src)).catch(() => null);
  metadataRequests.set(src, request);

  if (metadataRequests.size > MAX_CACHED_REQUESTS) {
    const oldest = metadataRequests.keys().next().value;
    if (oldest) metadataRequests.delete(oldest);
  }

  return request;
}
