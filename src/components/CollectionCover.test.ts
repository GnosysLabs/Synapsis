import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CollectionCover } from './CollectionCover';

function imageCount(markup: string) {
  return (markup.match(/<img\b/g) || []).length;
}

describe('CollectionCover', () => {
  it('uses an explicit cover as the whole cover instead of mixing in post previews', () => {
    const html = renderToStaticMarkup(createElement(CollectionCover, {
      title: 'Music videos',
      coverUrl: 'https://stuffbox.xyz/covers/music.jpg',
      previewImages: ['https://stuffbox.xyz/posts/preview.jpg'],
    }));

    expect(imageCount(html)).toBe(1);
    expect(html).toContain('https://stuffbox.xyz/covers/music.jpg');
    expect(html).not.toContain('https://stuffbox.xyz/posts/preview.jpg');
    expect(html).toContain('collection-cover-1');
  });

  it('keeps the post-media collage when no explicit cover is set', () => {
    const html = renderToStaticMarkup(createElement(CollectionCover, {
      title: 'Music videos',
      previewImages: [
        'https://stuffbox.xyz/posts/one.jpg',
        'https://stuffbox.xyz/posts/two.jpg',
      ],
    }));

    expect(imageCount(html)).toBe(2);
    expect(html).toContain('collection-cover-2');
  });
});
