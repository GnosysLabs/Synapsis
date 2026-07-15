import { describe, expect, it } from 'vitest';
import { shouldExposeAccountNsfwSettings } from './settings-visibility';

describe('shouldExposeAccountNsfwSettings', () => {
    it('hides account NSFW controls when the node is already NSFW', () => {
        expect(shouldExposeAccountNsfwSettings(true)).toBe(false);
    });

    it('keeps account NSFW controls available on general-purpose nodes', () => {
        expect(shouldExposeAccountNsfwSettings(false)).toBe(true);
    });
});
