import { describe, expect, it } from 'vitest';
import { getMaxMediaSize, getMediaKind, MAX_AUDIO_SIZE, MAX_IMAGE_SIZE } from './upload-policy';

describe('media upload policy', () => {
  it('recognizes common audio formats used for music uploads', () => {
    expect(getMediaKind('audio/mpeg')).toBe('audio');
    expect(getMediaKind('audio/wav')).toBe('audio');
    expect(getMediaKind('audio/flac')).toBe('audio');
    expect(getMediaKind('audio/mp4')).toBe('audio');
  });

  it('keeps images on the smaller limit and allows larger audio tracks', () => {
    expect(getMaxMediaSize('image/png')).toBe(MAX_IMAGE_SIZE);
    expect(getMaxMediaSize('audio/mpeg')).toBe(MAX_AUDIO_SIZE);
  });

  it('rejects unrelated file types', () => {
    expect(getMediaKind('application/pdf')).toBe('unsupported');
    expect(getMaxMediaSize('application/pdf')).toBeNull();
  });
});
