import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { signedRequest, SynapsisApiError } from './http.js';
import {
  MediaMetadataError,
  imageMetadataNeedsRasterization,
  stripMediaMetadataBytes,
} from './media-metadata.js';

const MIME_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/x-m4a'],
  ['.aac', 'audio/aac'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.flac', 'audio/flac'],
]);

export function mimeTypeForPath(path) {
  const mimeType = MIME_TYPES.get(extname(path).toLowerCase());
  if (!mimeType) throw new Error(`Unsupported media type: ${path}`);
  return mimeType;
}

export async function inspectMedia(path) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`Media path is not a file: ${path}`);
  const mimeType = mimeTypeForPath(path);
  if (metadata.size <= 0) throw new Error(`Media file is empty: ${path}`);
  return { filename: basename(path), mimeType, size: metadata.size };
}

function validatedUploadUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Stuffbox returned an unsafe upload URL');
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('Stuffbox upload URLs must use HTTPS unless they are local');
  }
  return url.toString();
}

async function directUploadFailureDetails(response) {
  const requestId = response.headers.get('x-amz-request-id') || response.headers.get('cf-ray');
  let code = null;
  try {
    const body = await response.text();
    code = body.match(/<Code>([A-Za-z0-9_.-]{1,80})<\/Code>/i)?.[1] || null;
  } catch {
    // The status still identifies the failed upload when the provider body is unavailable.
  }
  return [
    code,
    requestId && /^[A-Za-z0-9_.:-]{1,128}$/.test(requestId) ? `request ${requestId}` : null,
  ].filter(Boolean).join('; ');
}

export async function uploadMediaFile(profile, entry, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const inspected = await inspectMedia(entry.path);
  if (entry.alt && entry.alt.length > 1500) throw new Error('Media alt text must be 1500 characters or fewer');
  const originalBytes = new Uint8Array(await readFile(entry.path));
  if (inspected.mimeType.startsWith('image/')
    && imageMetadataNeedsRasterization(originalBytes, inspected.mimeType)) {
    throw new MediaMetadataError(
      `${inspected.filename} uses EXIF orientation. Normalize its orientation before uploading it with the CLI.`,
    );
  }
  const bytes = stripMediaMetadataBytes(originalBytes, inspected.mimeType);
  const uploadInput = { ...inspected, size: bytes.byteLength };

  options.onProgress?.(`Starting upload for ${inspected.filename}`);
  const upload = await signedRequest(profile, '/api/media/stuffbox/uploads', 'media_upload_start', {
    ...uploadInput,
  }, fetchImpl);
  if (!upload.id || !upload.uploadUrl) throw new Error('Synapsis returned an invalid Stuffbox upload session');
  const uploadUrl = validatedUploadUrl(upload.uploadUrl);

  const requiredHeaders = { ...(upload.requiredHeaders || {}) };

  let directResponse;
  try {
    directResponse = await fetchImpl(uploadUrl, {
      method: upload.method || 'PUT',
      headers: requiredHeaders,
      body: bytes,
    });
  } catch (error) {
    throw new SynapsisApiError(`Unable to upload media to Stuffbox: ${error.message}`, 0, 'DIRECT_UPLOAD_FAILED');
  }
  if (!directResponse.ok) {
    const details = await directUploadFailureDetails(directResponse);
    throw new SynapsisApiError(
      `Stuffbox rejected ${inspected.filename} (${directResponse.status}${details ? `; ${details}` : ''})`,
      directResponse.status,
      'DIRECT_UPLOAD_FAILED',
    );
  }

  options.onProgress?.(`Finishing upload for ${inspected.filename}`);
  const completed = await signedRequest(
    profile,
    `/api/media/stuffbox/uploads/${encodeURIComponent(upload.id)}/complete`,
    'media_upload_complete',
    { uploadId: upload.id, alt: entry.alt || null },
    fetchImpl,
  );
  if (!completed.media?.id || !completed.media?.url) {
    throw new Error('Synapsis returned an invalid completed media record');
  }
  return completed.media;
}
