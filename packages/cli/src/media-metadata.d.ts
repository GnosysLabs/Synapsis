export class MediaMetadataError extends Error {
  readonly code: 'METADATA_STRIP_FAILED';
}

export function imageExifOrientation(bytes: Uint8Array, mimeType: string): number;
export function imageMetadataNeedsRasterization(bytes: Uint8Array, mimeType: string): boolean;
export function stripMediaMetadataBytes(bytes: Uint8Array, mimeType: string): Uint8Array;
