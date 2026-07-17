import { describe, expect, it } from 'vitest';
import { canAccessNodeFeed, canAccessSensitiveRemoteProfile, shouldIncludeNsfwFeed } from './feed-access';

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
            viewer: { nsfwEnabled: false, ageVerifiedAt: '2026-07-17T00:00:00.000Z' },
            localNodeIsNsfw: true,
        })).toBe(true);
    });

    it('does not treat authentication alone as age consent on an NSFW node', () => {
        expect(shouldIncludeNsfwFeed({
            viewer: { nsfwEnabled: true, ageVerifiedAt: null },
            localNodeIsNsfw: true,
        })).toBe(false);
    });

    it('respects an enabled account preference on a general-purpose node', () => {
        expect(shouldIncludeNsfwFeed({
            viewer: { nsfwEnabled: true, ageVerifiedAt: '2026-07-17T00:00:00.000Z' },
            localNodeIsNsfw: false,
        })).toBe(true);
    });

    it('fails closed when the preference is enabled without an age-confirmation record', () => {
        expect(shouldIncludeNsfwFeed({
            viewer: { nsfwEnabled: true, ageVerifiedAt: null },
            localNodeIsNsfw: false,
        })).toBe(false);
    });

    it('filters NSFW posts when neither form of consent is present', () => {
        expect(shouldIncludeNsfwFeed({
            viewer: { nsfwEnabled: false },
            localNodeIsNsfw: false,
        })).toBe(false);
    });
});

describe('canAccessSensitiveRemoteProfile', () => {
    it('blocks signed-out visitors from profiles on adult-only nodes', () => {
        expect(canAccessSensitiveRemoteProfile({
            profileRequiresNsfw: true,
            viewer: null,
            localNodeIsNsfw: false,
        })).toBe(false);
    });

    it('blocks signed-in viewers who have not enabled NSFW on general-purpose nodes', () => {
        expect(canAccessSensitiveRemoteProfile({
            profileRequiresNsfw: true,
            viewer: { nsfwEnabled: false },
            localNodeIsNsfw: false,
        })).toBe(false);
    });

    it('allows viewers who explicitly enabled NSFW content', () => {
        expect(canAccessSensitiveRemoteProfile({
            profileRequiresNsfw: true,
            viewer: { nsfwEnabled: true, ageVerifiedAt: '2026-07-17T00:00:00.000Z' },
            localNodeIsNsfw: false,
        })).toBe(true);
    });

    it('leaves general-audience remote profiles public', () => {
        expect(canAccessSensitiveRemoteProfile({
            profileRequiresNsfw: false,
            viewer: null,
            localNodeIsNsfw: false,
        })).toBe(true);
    });
});
