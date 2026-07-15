'use client';

export interface UploadedMedia {
  id: string;
  url: string;
  altText?: string | null;
  mimeType?: string | null;
}

export class MediaUploadError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MediaUploadError';
  }
}

interface JsonResponse extends Record<string, unknown> {
  id?: string;
  uploadUrl?: string;
  requiredHeaders?: Record<string, string>;
  media?: UploadedMedia;
  error?: string;
  code?: string;
  provider?: string | null;
}

async function json(response: Response): Promise<JsonResponse> {
  return response.json().catch(() => ({})) as Promise<JsonResponse>;
}

function directPut(
  uploadUrl: string,
  file: File,
  headers: Record<string, string>,
  onProgress?: (progress: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', uploadUrl);
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    });
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress?.(1);
        resolve();
      } else {
        reject(new MediaUploadError(`Stuffbox rejected the upload (${request.status})`, 'DIRECT_UPLOAD_FAILED', request.status));
      }
    });
    request.addEventListener('error', () => reject(new MediaUploadError(
      'The browser could not reach Stuffbox. Check its CORS and public URL settings.',
      'DIRECT_UPLOAD_FAILED',
    )));
    request.addEventListener('abort', () => reject(new MediaUploadError('Upload cancelled', 'UPLOAD_CANCELLED')));
    request.send(file);
  });
}

async function uploadToStuffbox(file: File, onProgress?: (progress: number) => void): Promise<UploadedMedia> {
  const sessionResponse = await fetch('/api/media/stuffbox/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, mimeType: file.type, size: file.size }),
  });
  const session = await json(sessionResponse);
  if (!sessionResponse.ok) {
    throw new MediaUploadError(session.error || 'Unable to start upload', session.code, sessionResponse.status);
  }
  if (!session.id || !session.uploadUrl) {
    throw new MediaUploadError('Stuffbox returned an invalid upload session', 'INVALID_UPLOAD_SESSION');
  }

  await directPut(session.uploadUrl, file, session.requiredHeaders || {}, onProgress);

  const completeResponse = await fetch(`/api/media/stuffbox/uploads/${encodeURIComponent(session.id)}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const complete = await json(completeResponse);
  if (!completeResponse.ok || !complete.media?.url) {
    throw new MediaUploadError(complete.error || 'Unable to finish upload', complete.code, completeResponse.status);
  }
  return complete.media as UploadedMedia;
}

async function uploadToS3(file: File): Promise<UploadedMedia> {
  const formData = new FormData();
  formData.append('file', file);
  const response = await fetch('/api/media/upload', { method: 'POST', body: formData });
  const data = await json(response);
  if (!response.ok || !data.media?.url) {
    throw new MediaUploadError(data.error || 'Upload failed', data.code, response.status);
  }
  return data.media as UploadedMedia;
}

export async function uploadMediaFile(
  file: File,
  onProgress?: (progress: number) => void,
): Promise<UploadedMedia> {
  const configurationResponse = await fetch('/api/storage/configuration', { cache: 'no-store' });
  const configuration = await json(configurationResponse);
  if (!configurationResponse.ok) {
    throw new MediaUploadError(configuration.error || 'Unable to load storage configuration', undefined, configurationResponse.status);
  }

  if (configuration.provider === 'stuffbox') return uploadToStuffbox(file, onProgress);
  if (configuration.provider === 's3') return uploadToS3(file);
  throw new MediaUploadError('Connect media storage before uploading.', 'STORAGE_NOT_CONFIGURED', 409);
}
