export const E2EE_MEDIA_MIME_TYPE = 'application/vnd.stuffbox.client-encrypted';
export const E2EE_MEDIA_ALGORITHM = 'xchacha20-poly1305-ietf-chunked' as const;
export const E2EE_MEDIA_CHUNK_SIZE = 1024 * 1024;
export const E2EE_MEDIA_AUTH_TAG_BYTES = 16;

export interface E2EEMediaEncryption {
  version: 1;
  algorithm: typeof E2EE_MEDIA_ALGORITHM;
  key: string;
  noncePrefix: string;
  mediaId: string;
  chunkSize: typeof E2EE_MEDIA_CHUNK_SIZE;
  ciphertextSize: number;
}

export interface E2EEMediaAttachmentMetadata {
  filename: string;
  mimeType: string;
  size: number;
  encryption: E2EEMediaEncryption;
}

