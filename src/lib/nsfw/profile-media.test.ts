import { describe, expect, it } from 'vitest';
import { shouldBlurProfileMedia } from './profile-media';

describe('shouldBlurProfileMedia', () => {
    it('blurs sensitive account media for signed-out viewers', () => {
        expect(shouldBlurProfileMedia({ accountIsNsfw: true, viewer: null })).toBe(true);
    });

    it('blurs every account from an NSFW node when the viewer has NSFW disabled', () => {
        expect(shouldBlurProfileMedia({ nodeIsNsfw: true, viewer: { nsfwEnabled: false } })).toBe(true);
    });

    it('shows sensitive profile media when the viewer has enabled NSFW', () => {
        expect(shouldBlurProfileMedia({ accountIsNsfw: true, nodeIsNsfw: true, viewer: { nsfwEnabled: true } })).toBe(false);
    });

    it('does not blur safe profile media', () => {
        expect(shouldBlurProfileMedia({ viewer: null })).toBe(false);
    });
});
