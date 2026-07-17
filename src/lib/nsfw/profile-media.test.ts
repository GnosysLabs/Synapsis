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
            viewer: { nsfwEnabled: false, ageVerifiedAt: '2026-07-17T00:00:00.000Z' },
        })).toBe(false);
    });

    it('defaults authenticated adult-node members to visible profile media', () => {
        expect(shouldBlurProfileMedia({
            accountIsNsfw: true,
            nodeIsNsfw: true,
            localNodeIsNsfw: true,
            viewer: { nsfwEnabled: false, ageVerifiedAt: null },
        })).toBe(false);
    });

    it('shows sensitive profile media when the viewer has enabled NSFW', () => {
        expect(shouldBlurProfileMedia({
            accountIsNsfw: true,
            nodeIsNsfw: true,
            viewer: { nsfwEnabled: true, ageVerifiedAt: '2026-07-17T00:00:00.000Z' },
        })).toBe(false);
    });

    it('keeps sensitive media hidden when age confirmation is missing', () => {
        expect(shouldBlurProfileMedia({
            accountIsNsfw: true,
            viewer: { nsfwEnabled: true, ageVerifiedAt: null },
        })).toBe(true);
    });

    it('does not blur safe profile media', () => {
        expect(shouldBlurProfileMedia({ viewer: null })).toBe(false);
    });
});
