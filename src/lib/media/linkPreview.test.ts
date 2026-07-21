import { describe, expect, it } from 'vitest';
import {
  findLinkPreviewUrlInText,
  proxiedLinkPreviewImageUrl,
} from './linkPreview';

describe('link preview URLs', () => {
  it('finds and normalizes the first public HTTPS link in post text', () => {
    expect(findLinkPreviewUrlInText(
      'A guide: pcgamer.com/games/survival-crafting/palworld-every-new-pal-location/.'
    )).toBe(
      'https://pcgamer.com/games/survival-crafting/palworld-every-new-pal-location/'
    );
  });

  it('does not mistake a canonical account mention for a link', () => {
    expect(findLinkPreviewUrlInText('Hello @alice@example.com')).toBeNull();
  });

  it('keeps external artwork behind the local-node image proxy', () => {
    expect(proxiedLinkPreviewImageUrl('https://images.example/story.jpg')).toBe(
      '/api/media/preview/image?url=https%3A%2F%2Fimages.example%2Fstory.jpg'
    );
  });
});
