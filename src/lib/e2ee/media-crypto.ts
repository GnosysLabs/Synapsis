'use client';

import sodium from 'libsodium-wrappers-sumo';

import { fromBase64Url, toBase64Url } from './client-crypto';
import {
  E2EE_MEDIA_ALGORITHM,
  E2EE_MEDIA_AUTH_TAG_BYTES,
  E2EE_MEDIA_CHUNK_SIZE,
  E2EE_MEDIA_MIME_TYPE,
  type E2EEMediaAttachmentMetadata,
  type E2EEMediaEncryption,
} from './media-format';

const encoder = new TextEncoder();

async function ready(): Promise<typeof sodium> {
  await sodium.ready;
  return sodium;
}

function chunkCount(plaintextSize: number, chunkSize: number): number {
  return Math.ceil(plaintextSize / chunkSize);
}

export function encryptedMediaCiphertextSize(
  plaintextSize: number,
  chunkSize = E2EE_MEDIA_CHUNK_SIZE,
): number {
  if (!Number.isSafeInteger(plaintextSize) || plaintextSize <= 0) {
    throw new Error('Encrypted media must contain at least one byte');
  }
  const size = plaintextSize + chunkCount(plaintextSize, chunkSize) * E2EE_MEDIA_AUTH_TAG_BYTES;
  if (!Number.isSafeInteger(size)) throw new Error('Encrypted media is too large');
  return size;
}

function chunkPlaintextSize(plaintextSize: number, chunkSize: number, index: number): number {
  return Math.min(chunkSize, plaintextSize - index * chunkSize);
}

function chunkNonce(prefix: Uint8Array, index: number): Uint8Array {
  if (prefix.byteLength !== 16 || !Number.isSafeInteger(index) || index < 0) {
    throw new Error('Encrypted media nonce is invalid');
  }
  const nonce = new Uint8Array(24);
  nonce.set(prefix, 0);
  let remaining = index;
  for (let offset = 23; offset >= 16; offset -= 1) {
    nonce[offset] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  return nonce;
}

function chunkAuthenticatedData(
  encryption: Pick<E2EEMediaEncryption, 'version' | 'algorithm' | 'mediaId' | 'chunkSize'>,
  plaintextSize: number,
  index: number,
  plaintextChunkSize: number,
): Uint8Array {
  return encoder.encode(JSON.stringify([
    'synapsis-e2ee-media',
    encryption.version,
    encryption.algorithm,
    encryption.mediaId,
    encryption.chunkSize,
    plaintextSize,
    index,
    plaintextChunkSize,
  ]));
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export interface EncryptedMediaFile {
  ciphertext: File;
  encryption: E2EEMediaEncryption;
}

export async function encryptE2EEMediaFile(
  file: File,
  onProgress?: (progress: number) => void,
): Promise<EncryptedMediaFile> {
  const ciphertextSize = encryptedMediaCiphertextSize(file.size);
  const crypto = await ready();
  const key = crypto.randombytes_buf(crypto.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
  const noncePrefix = crypto.randombytes_buf(16);
  const mediaIdBytes = crypto.randombytes_buf(16);
  const encryption: E2EEMediaEncryption = {
    version: 1,
    algorithm: E2EE_MEDIA_ALGORITHM,
    key: toBase64Url(key),
    noncePrefix: toBase64Url(noncePrefix),
    mediaId: toBase64Url(mediaIdBytes),
    chunkSize: E2EE_MEDIA_CHUNK_SIZE,
    ciphertextSize,
  };
  const totalChunks = chunkCount(file.size, encryption.chunkSize);
  const parts: BlobPart[] = [];

  try {
    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * encryption.chunkSize;
      const end = Math.min(file.size, start + encryption.chunkSize);
      const plaintext = new Uint8Array(await file.slice(start, end).arrayBuffer());
      try {
        const ciphertext = crypto.crypto_aead_xchacha20poly1305_ietf_encrypt(
          plaintext,
          chunkAuthenticatedData(encryption, file.size, index, plaintext.byteLength),
          null,
          chunkNonce(noncePrefix, index),
          key,
        );
        parts.push(copyBuffer(ciphertext));
      } finally {
        crypto.memzero(plaintext);
      }
      onProgress?.((index + 1) / totalChunks);
    }

    const ciphertext = new File(parts, 'encrypted-chat-media.e2ee', {
      type: E2EE_MEDIA_MIME_TYPE,
      lastModified: Date.now(),
    });
    if (ciphertext.size !== ciphertextSize) throw new Error('Encrypted media size is invalid');
    return { ciphertext, encryption };
  } finally {
    crypto.memzero(key);
    crypto.memzero(noncePrefix);
    crypto.memzero(mediaIdBytes);
  }
}

export async function decryptE2EEMediaBlob(
  ciphertext: Blob,
  metadata: E2EEMediaAttachmentMetadata,
  signal?: AbortSignal,
): Promise<Blob> {
  if (ciphertext.size !== metadata.encryption.ciphertextSize) {
    throw new Error('Encrypted attachment size does not match its signed descriptor');
  }
  if (encryptedMediaCiphertextSize(metadata.size, metadata.encryption.chunkSize)
    !== metadata.encryption.ciphertextSize) {
    throw new Error('Encrypted attachment descriptor is inconsistent');
  }

  const crypto = await ready();
  const key = fromBase64Url(metadata.encryption.key);
  const noncePrefix = fromBase64Url(metadata.encryption.noncePrefix);
  if (key.byteLength !== crypto.crypto_aead_xchacha20poly1305_ietf_KEYBYTES
    || noncePrefix.byteLength !== 16) {
    throw new Error('Encrypted attachment key material is invalid');
  }

  const totalChunks = chunkCount(metadata.size, metadata.encryption.chunkSize);
  const parts: BlobPart[] = [];
  let ciphertextOffset = 0;
  try {
    for (let index = 0; index < totalChunks; index += 1) {
      if (signal?.aborted) throw new DOMException('Attachment decryption was cancelled', 'AbortError');
      const plaintextLength = chunkPlaintextSize(metadata.size, metadata.encryption.chunkSize, index);
      const ciphertextLength = plaintextLength + E2EE_MEDIA_AUTH_TAG_BYTES;
      const encryptedChunk = new Uint8Array(await ciphertext
        .slice(ciphertextOffset, ciphertextOffset + ciphertextLength)
        .arrayBuffer());
      const plaintext = crypto.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        encryptedChunk,
        chunkAuthenticatedData(metadata.encryption, metadata.size, index, plaintextLength),
        chunkNonce(noncePrefix, index),
        key,
      );
      if (plaintext.byteLength !== plaintextLength) {
        crypto.memzero(plaintext);
        throw new Error('Encrypted attachment chunk has an invalid length');
      }
      parts.push(copyBuffer(plaintext));
      crypto.memzero(plaintext);
      ciphertextOffset += ciphertextLength;
    }
    if (ciphertextOffset !== ciphertext.size) throw new Error('Encrypted attachment has trailing data');
    return new Blob(parts, { type: metadata.mimeType });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('Encrypted attachment could not be authenticated or decrypted', { cause: error });
  } finally {
    crypto.memzero(key);
    crypto.memzero(noncePrefix);
  }
}
