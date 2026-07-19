'use client';

import {
  MediaMetadataError,
  imageMetadataNeedsRasterization,
  stripMediaMetadataBytes,
} from './strip-metadata';

const RASTER_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

async function canvasBlob(canvas: HTMLCanvasElement, mimeType: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new MediaMetadataError('The browser could not create a private copy of this image.')),
      mimeType,
      mimeType === 'image/jpeg' || mimeType === 'image/webp' ? 0.95 : undefined,
    );
  });
}

async function normalizedImage(file: File): Promise<Blob> {
  const canvas = document.createElement('canvas');
  let source: CanvasImageSource;
  let cleanup = () => {};

  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    source = bitmap;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    cleanup = () => bitmap.close();
  } else {
    const url = URL.createObjectURL(file);
    const image = new Image();
    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new MediaMetadataError('The browser could not decode this image.'));
        image.src = url;
      });
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
    source = image;
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    cleanup = () => URL.revokeObjectURL(url);
  }

  try {
    if (canvas.width === 0 || canvas.height === 0) {
      throw new MediaMetadataError('The browser could not determine this image\'s dimensions.');
    }
    const context = canvas.getContext('2d');
    if (!context) throw new MediaMetadataError('The browser could not create a private copy of this image.');
    context.drawImage(source, 0, 0);
    return await canvasBlob(canvas, file.type);
  } finally {
    cleanup();
  }
}

export async function stripPhotoVideoMetadata(file: File): Promise<File> {
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) return file;
  let bytes = new Uint8Array(await file.arrayBuffer());

  if (RASTER_IMAGE_TYPES.has(file.type) && imageMetadataNeedsRasterization(bytes, file.type)) {
    const normalized = await normalizedImage(file);
    bytes = new Uint8Array(await normalized.arrayBuffer());
  }

  const sanitized = stripMediaMetadataBytes(bytes, file.type);
  const privateBytes = new Uint8Array(sanitized.byteLength);
  privateBytes.set(sanitized);
  return new File([privateBytes.buffer], file.name, { type: file.type, lastModified: file.lastModified });
}
