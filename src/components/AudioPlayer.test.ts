import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AudioPlayer } from './AudioPlayer';

describe('AudioPlayer', () => {
  it('preloads track metadata without waiting for playback', () => {
    const markup = renderToStaticMarkup(createElement(AudioPlayer, {
      src: 'https://stuffbox.xyz/f/public-track',
      title: 'Audio by Cyph3rASi',
    }));

    expect(markup).toContain('preload="metadata"');
    expect(markup).not.toContain('preload="none"');
    expect(markup).toContain('Play Audio by Cyph3rASi');
  });
});
