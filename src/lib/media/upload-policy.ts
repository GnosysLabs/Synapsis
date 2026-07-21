export const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;

export const ALLOWED_VIDEO_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
] as const;

export const ALLOWED_AUDIO_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/flac',
  'audio/x-flac',
] as const;

export const ALLOWED_MEDIA_TYPES = [
  ...ALLOWED_IMAGE_TYPES,
  ...ALLOWED_VIDEO_TYPES,
  ...ALLOWED_AUDIO_TYPES,
] as const;

export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
// Animated GIFs are much less space-efficient than still images. Treat them
// like other animated media instead of rejecting otherwise normal uploads at
// the still-image ceiling.
export const MAX_GIF_SIZE = 100 * 1024 * 1024;
export const MAX_VIDEO_SIZE = 100 * 1024 * 1024;
export const MAX_AUDIO_SIZE = 100 * 1024 * 1024;

export type MediaKind = 'image' | 'video' | 'audio' | 'unsupported';

export function getMediaKind(mimeType?: string | null): MediaKind {
  if (!mimeType) return 'unsupported';
  if ((ALLOWED_IMAGE_TYPES as readonly string[]).includes(mimeType)) return 'image';
  if ((ALLOWED_VIDEO_TYPES as readonly string[]).includes(mimeType)) return 'video';
  if ((ALLOWED_AUDIO_TYPES as readonly string[]).includes(mimeType)) return 'audio';
  return 'unsupported';
}

export function getMaxMediaSize(mimeType: string): number | null {
  if (mimeType === 'image/gif') return MAX_GIF_SIZE;
  const kind = getMediaKind(mimeType);
  if (kind === 'image') return MAX_IMAGE_SIZE;
  if (kind === 'video') return MAX_VIDEO_SIZE;
  if (kind === 'audio') return MAX_AUDIO_SIZE;
  return null;
}
