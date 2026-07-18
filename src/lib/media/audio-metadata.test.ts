import { describe, expect, it } from 'vitest';

import { normalizeAudioMetadata } from './audio-metadata';

describe('normalizeAudioMetadata', () => {
  it('uses embedded track details and prefers front cover art', () => {
    const frontCover = new Uint8Array([1, 2, 3]);
    const metadata = normalizeAudioMetadata({
      title: '  Midnight Drive ',
      artist: ' The Satellites ',
      album: ' After Dark ',
      picture: [
        { data: new Uint8Array([9]), format: 'png', type: 'Back cover' },
        { data: frontCover, format: 'jpg', type: 'Cover (front)' },
      ],
    });

    expect(metadata).toEqual({
      title: 'Midnight Drive',
      artist: 'The Satellites',
      album: 'After Dark',
      artwork: { data: frontCover, mimeType: 'image/jpeg' },
    });
  });

  it('falls back through alternate artist tags and ignores empty metadata', () => {
    expect(normalizeAudioMetadata({ artists: ['Alice', 'Bob'] })?.artist).toBe('Alice, Bob');
    expect(normalizeAudioMetadata({ albumartist: 'The Ensemble' })?.artist).toBe('The Ensemble');
    expect(normalizeAudioMetadata({ title: ' ', artist: '' })).toBeNull();
  });
});
