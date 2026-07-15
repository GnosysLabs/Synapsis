import { describe, expect, it } from 'vitest';
import { getDiceBearAvatarUrl } from './AvatarImage';

describe('getDiceBearAvatarUrl', () => {
    it('uses the site-wide bottts-neutral style and a stable encoded handle seed', () => {
        expect(getDiceBearAvatarUrl('cyph3r@node.example')).toBe(
            'https://api.dicebear.com/9.x/bottts-neutral/svg?seed=cyph3r%40node.example',
        );
    });
});
