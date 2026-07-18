import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { parseVideoEmbedUrl, VideoEmbed } from './VideoEmbed';

describe('VideoEmbed', () => {
    it('does not contact a video provider before the viewer opts in', () => {
        const html = renderToStaticMarkup(createElement(VideoEmbed, {
            url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        }));

        expect(html).toContain('Load YouTube video');
        expect(html).not.toContain('<iframe');
        expect(html).not.toContain('youtube-nocookie.com');
    });

    it('builds only hard-coded privacy-enhanced provider URLs', () => {
        expect(parseVideoEmbedUrl('https://youtu.be/dQw4w9WgXcQ')).toEqual({
            provider: 'YouTube',
            embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
        });
        expect(parseVideoEmbedUrl('https://vimeo.com/123456789')).toEqual({
            provider: 'Vimeo',
            embedUrl: 'https://player.vimeo.com/video/123456789',
        });
        expect(parseVideoEmbedUrl('https://attacker.example/youtu.be/dQw4w9WgXcQ')).toBeNull();
    });
});
