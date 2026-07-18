import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import BlurredVideo, { formatVideoTime } from './BlurredVideo';

describe('BlurredVideo', () => {
    it('autoplays muted inline on a loop with accessible playback, seek, and sound controls', () => {
        const markup = renderToStaticMarkup(
            createElement(BlurredVideo, { src: 'https://example.com/video.mp4' })
        );

        expect(markup.match(/<video/g)).toHaveLength(2);
        expect(markup.match(/autoPlay=""/g)).toHaveLength(2);
        expect(markup.match(/muted=""/g)).toHaveLength(2);
        expect(markup.match(/loop=""/g)).toHaveLength(2);
        expect(markup.match(/playsInline=""/g)).toHaveLength(2);
        expect(markup).toContain('class="blurred-video-bg"');
        expect(markup).toContain('aria-hidden="true"');
        expect(markup).toContain('aria-label="Play video"');
        expect(markup).toContain('aria-label="Seek video"');
        expect(markup).toContain('type="range"');
        expect(markup).toContain('aria-label="Unmute video"');
        expect(markup).toContain('preload="metadata"');
        expect(markup).not.toContain('preload="none"');
    });

    it('formats video timestamps', () => {
        expect(formatVideoTime(0)).toBe('0:00');
        expect(formatVideoTime(65.9)).toBe('1:05');
        expect(formatVideoTime(Number.POSITIVE_INFINITY)).toBe('0:00');
    });
});
