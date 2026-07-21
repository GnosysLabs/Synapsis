import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchGenericLinkPreview: vi.fn(),
  fetchRedditRichPreview: vi.fn(),
}));

vi.mock('./genericPreview', () => ({
  fetchGenericLinkPreview: mocks.fetchGenericLinkPreview,
}));
vi.mock('./redditPreview', () => ({
  fetchRedditRichPreview: mocks.fetchRedditRichPreview,
}));

import { resolveLinkPreview } from './resolveLinkPreview';

describe('resolveLinkPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchGenericLinkPreview.mockResolvedValue(null);
    mocks.fetchRedditRichPreview.mockResolvedValue(null);
  });

  it('returns fetched article metadata', async () => {
    const url = 'https://www.pcgamer.com/games/example-story/';
    mocks.fetchGenericLinkPreview.mockResolvedValue({
      url,
      title: 'Palworld guide',
      description: 'Every new Pal and location.',
      image: 'https://cdn.example/palworld.jpg',
      type: 'image',
      videoUrl: null,
      media: [{ url: 'https://cdn.example/palworld.jpg' }],
    });

    await expect(resolveLinkPreview(url)).resolves.toMatchObject({
      title: 'Palworld guide',
      image: 'https://cdn.example/palworld.jpg',
    });
  });

  it('still returns a domain card when the publisher metadata is unavailable', async () => {
    await expect(resolveLinkPreview('https://www.example.com/story')).resolves.toEqual({
      url: 'https://www.example.com/story',
      title: 'example.com',
      description: null,
      image: null,
      type: 'card',
      videoUrl: null,
      media: null,
    });
  });
});
