import { describe, expect, it } from 'vitest';
import { shouldIncludeNsfwFeed } from './feed-access';

describe('shouldIncludeNsfwFeed', () => {
    it('keeps NSFW posts hidden from signed-out visitors on an NSFW node', () => {
        expect(shouldIncludeNsfwFeed({ viewer: null, localNodeIsNsfw: true })).toBe(false);
    });

    it('includes NSFW posts for authenticated members of an NSFW node', () => {
        expect(shouldIncludeNsfwFeed({
            viewer: { nsfwEnabled: false },
            localNodeIsNsfw: true,
        })).toBe(true);
    });

    it('respects an enabled account preference on a general-purpose node', () => {
        expect(shouldIncludeNsfwFeed({
            viewer: { nsfwEnabled: true },
            localNodeIsNsfw: false,
        })).toBe(true);
    });

    it('filters NSFW posts when neither form of consent is present', () => {
        expect(shouldIncludeNsfwFeed({
            viewer: { nsfwEnabled: false },
            localNodeIsNsfw: false,
        })).toBe(false);
    });
});
