import { describe, expect, it } from 'vitest';
import { getVideoPreviewTime, primeVideoPreviewFrame } from './video-preview';

describe('video upload previews', () => {
    it('selects a representative frame one second into a normal video', () => {
        expect(getVideoPreviewTime(30)).toBe(1);
    });

    it('uses the midpoint for videos shorter than two seconds', () => {
        expect(getVideoPreviewTime(0.8)).toBe(0.4);
    });

    it('seeks away from an undecoded first frame when metadata is incomplete', () => {
        const video = { currentTime: 0, duration: Number.NaN };

        primeVideoPreviewFrame(video);

        expect(video.currentTime).toBe(0.001);
    });
});
