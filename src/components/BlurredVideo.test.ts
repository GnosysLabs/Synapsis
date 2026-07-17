import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import BlurredVideo, { formatVideoTime } from './BlurredVideo';

describe('BlurredVideo', () => {
    it('renders accessible playback, seek, and sound controls', () => {
        const markup = renderToStaticMarkup(
            createElement(BlurredVideo, { src: 'https://example.com/video.mp4' })
        );

        expect(markup).toContain('aria-label="Play video"');
        expect(markup).toContain('aria-label="Seek video"');
        expect(markup).toContain('type="range"');
        expect(markup).toContain('aria-label="Unmute video"');
    });

    it('formats video timestamps', () => {
        expect(formatVideoTime(0)).toBe('0:00');
        expect(formatVideoTime(65.9)).toBe('1:05');
        expect(formatVideoTime(Number.POSITIVE_INFINITY)).toBe('0:00');
    });
});
