import { describe, expect, it } from 'vitest';
import { hasPublishablePostContent } from './content-policy';

describe('hasPublishablePostContent', () => {
    it('accepts a text-only post', () => {
        expect(hasPublishablePostContent('Hello swarm', [])).toBe(true);
    });

    it('accepts attached media without a caption', () => {
        expect(hasPublishablePostContent('', ['media-id'])).toBe(true);
        expect(hasPublishablePostContent('   ', ['media-id'])).toBe(true);
    });

    it('rejects a completely empty post', () => {
        expect(hasPublishablePostContent('', [])).toBe(false);
        expect(hasPublishablePostContent('   ', undefined)).toBe(false);
    });
});
