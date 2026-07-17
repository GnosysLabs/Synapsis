import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { signedRequest, SynapsisApiError } from './http.js';

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

const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_OTHER_SIZE = 100 * 1024 * 1024;

export function mimeTypeForPath(path) {
  const mimeType = MIME_TYPES.get(extname(path).toLowerCase());
  if (!mimeType) throw new Error(`Unsupported media type: ${path}`);
  return mimeType;
}

export async function inspectMedia(path) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`Media path is not a file: ${path}`);
  const mimeType = mimeTypeForPath(path);
  const maximum = mimeType.startsWith('image/') ? MAX_IMAGE_SIZE : MAX_OTHER_SIZE;
  if (metadata.size <= 0) throw new Error(`Media file is empty: ${path}`);
  if (metadata.size > maximum) {
    throw new Error(`${basename(path)} is larger than ${Math.round(maximum / 1024 / 1024)}MB`);
  }
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

export async function uploadMediaFile(profile, entry, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const inspected = await inspectMedia(entry.path);
  if (entry.alt && entry.alt.length > 1500) throw new Error('Media alt text must be 1500 characters or fewer');
  const bytes = await readFile(entry.path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  options.onProgress?.(`Starting upload for ${inspected.filename}`);
  const upload = await signedRequest(profile, '/api/media/stuffbox/uploads', 'media_upload_start', {
    ...inspected,
    sha256,
  }, fetchImpl);
  if (!upload.id || !upload.uploadUrl) throw new Error('Synapsis returned an invalid Stuffbox upload session');
  const uploadUrl = validatedUploadUrl(upload.uploadUrl);

  const requiredHeaders = { ...(upload.requiredHeaders || {}) };
  const hasContentType = Object.keys(requiredHeaders).some(name => name.toLowerCase() === 'content-type');
  if (!hasContentType) requiredHeaders['Content-Type'] = inspected.mimeType;

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
    throw new SynapsisApiError(
      `Stuffbox rejected ${inspected.filename} (${directResponse.status})`,
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
