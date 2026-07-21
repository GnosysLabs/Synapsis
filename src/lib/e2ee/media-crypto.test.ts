import { describe, expect, it } from 'vitest';

import { decryptE2EEMediaBlob, encryptE2EEMediaFile } from './media-crypto';
import { E2EE_MEDIA_CHUNK_SIZE, E2EE_MEDIA_MIME_TYPE } from './media-format';

function bytesBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

describe('E2EE media encryption', () => {
  it('round-trips and authenticates a file spanning multiple chunks', async () => {
    const source = new Uint8Array(E2EE_MEDIA_CHUNK_SIZE + 37);
    for (let index = 0; index < source.length; index += 1) source[index] = index % 251;
    const file = new File([bytesBuffer(source)], 'private-video.mp4', { type: 'video/mp4' });

    const encrypted = await encryptE2EEMediaFile(file);
    expect(encrypted.ciphertext.type).toBe(E2EE_MEDIA_MIME_TYPE);
    expect(encrypted.ciphertext.name).toBe('encrypted-chat-media.e2ee');
    expect(encrypted.ciphertext.size).toBe(source.byteLength + 32);

    const plaintext = await decryptE2EEMediaBlob(encrypted.ciphertext, {
      filename: file.name,
      mimeType: file.type,
      size: file.size,
      encryption: encrypted.encryption,
    });
    expect(plaintext.type).toBe('video/mp4');
    expect(new Uint8Array(await plaintext.arrayBuffer())).toEqual(source);
  });

  it('fails closed when ciphertext is altered', async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4]).buffer], 'private.png', { type: 'image/png' });
    const encrypted = await encryptE2EEMediaFile(file);
    const corrupted = new Uint8Array(await encrypted.ciphertext.arrayBuffer());
    corrupted[0] ^= 0xff;

    await expect(decryptE2EEMediaBlob(new Blob([bytesBuffer(corrupted)]), {
      filename: file.name,
      mimeType: file.type,
      size: file.size,
      encryption: encrypted.encryption,
    })).rejects.toThrow(/authenticated or decrypted/i);
  });
});
