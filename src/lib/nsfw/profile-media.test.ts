import { describe, expect, it } from 'vitest';
import { shouldBlurProfileMedia } from './profile-media';

describe('shouldBlurProfileMedia', () => {
    it('blurs sensitive account media for signed-out viewers', () => {
        expect(shouldBlurProfileMedia({ accountIsNsfw: true, viewer: null })).toBe(true);
    });

    it('blurs media from an NSFW node for a viewer on a non-NSFW node with NSFW disabled', () => {
        expect(shouldBlurProfileMedia({ nodeIsNsfw: true, localNodeIsNsfw: false, viewer: { nsfwEnabled: false } })).toBe(true);
    });

    it('shows sensitive media to an authenticated member of the local NSFW node', () => {
        expect(shouldBlurProfileMedia({
            accountIsNsfw: true,
            nodeIsNsfw: true,
            localNodeIsNsfw: true,
            viewer: { nsfwEnabled: false },
        })).toBe(false);
    });

    it('shows sensitive profile media when the viewer has enabled NSFW', () => {
        expect(shouldBlurProfileMedia({ accountIsNsfw: true, nodeIsNsfw: true, viewer: { nsfwEnabled: true } })).toBe(false);
    });

    it('does not blur safe profile media', () => {
        expect(shouldBlurProfileMedia({ viewer: null })).toBe(false);
    });
});
