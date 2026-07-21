import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { VideoEmbed } from './VideoEmbed';

describe('VideoEmbed', () => {
    it('renders the normal playable provider iframe immediately', () => {
        const html = renderToStaticMarkup(createElement(VideoEmbed, {
            url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        }));

        expect(html).toContain('<iframe');
        expect(html).toContain('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
        expect(html).toContain('referrerPolicy="strict-origin-when-cross-origin"');
        expect(html).toContain('clipboard-write');
        expect(html).not.toContain('sandbox=');
        expect(html).not.toContain('Load YouTube video');
    });
});
