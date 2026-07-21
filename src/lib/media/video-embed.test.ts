import { describe, expect, it } from 'vitest';

import {
  buildVideoLinkPreview,
  findVideoEmbedUrlInText,
  parseVideoEmbedUrl,
} from './video-embed';

const youtubeId = 'dQw4w9WgXcQ';

describe('video embeds', () => {
  it.each([
    `https://www.youtube.com/watch?v=${youtubeId}&feature=share`,
    `https://m.youtube.com/watch?feature=share&v=${youtubeId}`,
    `https://youtu.be/${youtubeId}?si=abc`,
    `https://www.youtube.com/shorts/${youtubeId}`,
    `https://www.youtube.com/live/${youtubeId}`,
    `https://www.youtube.com/embed/${youtubeId}`,
    `https://www.youtube-nocookie.com/embed/${youtubeId}`,
  ])('accepts a supported YouTube URL: %s', (url) => {
    expect(parseVideoEmbedUrl(url)).toMatchObject({
      provider: 'YouTube',
      embedUrl: `https://www.youtube-nocookie.com/embed/${youtubeId}`,
    });
  });

  it.each([
    ['https://vimeo.com/123456789', 'https://player.vimeo.com/video/123456789'],
    ['https://player.vimeo.com/video/123456789', 'https://player.vimeo.com/video/123456789'],
  ])('accepts a supported Vimeo URL: %s', (url, embedUrl) => {
    expect(parseVideoEmbedUrl(url)).toMatchObject({ provider: 'Vimeo', embedUrl });
  });

  it('finds the first visible supported video and trims sentence wrappers', () => {
    expect(findVideoEmbedUrlInText(
      `Read https://example.com first, then watch (https://youtu.be/${youtubeId}).`,
    )).toBe(`https://youtu.be/${youtubeId}`);
    expect(findVideoEmbedUrlInText(
      `<a href="https://youtu.be/${youtubeId}">hidden destination</a>`,
    )).toBeNull();
    expect(findVideoEmbedUrlInText(
      `<p>Watch https://www.youtube.com/watch?v=${youtubeId}</p>`,
    )).toBe(`https://www.youtube.com/watch?v=${youtubeId}`);
  });

  it.each([
    `http://www.youtube.com/watch?v=${youtubeId}`,
    `https://attacker@www.youtube.com/watch?v=${youtubeId}`,
    `https://www.youtube.com:444/watch?v=${youtubeId}`,
    `https://youtube.com.evil.test/watch?v=${youtubeId}`,
    `https://evil-youtube.com/watch?v=${youtubeId}`,
    `https://www.youtube.com/anything?v=${youtubeId}`,
    `https://youtu.be/${youtubeId}/extra`,
    `https://www.youtube.com/shorts/${youtubeId}/extra`,
    'https://vimeo.com/videos/123456789',
    `https://evil.test/?next=https://youtu.be/${youtubeId}`,
  ])('rejects an unsafe or unsupported URL: %s', (url) => {
    expect(parseVideoEmbedUrl(url)).toBeNull();
    expect(findVideoEmbedUrlInText(url)).toBeNull();
  });

  it('builds fetch-free preview metadata for a recognized provider', () => {
    expect(buildVideoLinkPreview(`youtube.com/watch?v=${youtubeId}`)).toEqual({
      url: `https://youtube.com/watch?v=${youtubeId}`,
      title: 'YouTube',
      description: null,
      image: null,
      type: 'video',
      videoUrl: null,
      media: null,
    });
  });
});
