import { describe, expect, it } from 'vitest';
import { canAccessNodeFeed, shouldIncludeNsfwFeed } from './feed-access';

describe('canAccessNodeFeed', () => {
    it('blocks signed-out visitors on an NSFW node', () => {
        expect(canAccessNodeFeed({
            isAuthenticated: false,
            localNodeIsNsfw: true,
        })).toBe(false);
    });

    it('allows a local session to access an NSFW node', () => {
        expect(canAccessNodeFeed({
            isAuthenticated: true,
            localNodeIsNsfw: true,
        })).toBe(true);
    });

    it('keeps general-purpose node feeds public', () => {
        expect(canAccessNodeFeed({
            isAuthenticated: false,
            localNodeIsNsfw: false,
        })).toBe(true);
    });
});

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
