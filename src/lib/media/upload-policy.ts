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

export type MediaKind = 'image' | 'video' | 'audio' | 'unsupported';

export function getMediaKind(mimeType?: string | null): MediaKind {
  if (!mimeType) return 'unsupported';
  if ((ALLOWED_IMAGE_TYPES as readonly string[]).includes(mimeType)) return 'image';
  if ((ALLOWED_VIDEO_TYPES as readonly string[]).includes(mimeType)) return 'video';
  if ((ALLOWED_AUDIO_TYPES as readonly string[]).includes(mimeType)) return 'audio';
  return 'unsupported';
}
