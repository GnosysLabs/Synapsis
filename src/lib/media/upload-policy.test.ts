import { describe, expect, it } from 'vitest';
import { getMediaKind } from './upload-policy';

describe('media upload policy', () => {
  it('recognizes common audio formats used for music uploads', () => {
    expect(getMediaKind('audio/mpeg')).toBe('audio');
    expect(getMediaKind('audio/wav')).toBe('audio');
    expect(getMediaKind('audio/flac')).toBe('audio');
    expect(getMediaKind('audio/mp4')).toBe('audio');
  });

  it('recognizes supported images and animated media without a size policy', () => {
    expect(getMediaKind('image/png')).toBe('image');
    expect(getMediaKind('image/gif')).toBe('image');
    expect(getMediaKind('video/mp4')).toBe('video');
  });

  it('rejects unrelated file types', () => {
    expect(getMediaKind('application/pdf')).toBe('unsupported');
  });
});
