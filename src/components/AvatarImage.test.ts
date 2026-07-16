import { describe, expect, it } from 'vitest';
import { getDiceBearAvatarSeed, getDiceBearAvatarUrl } from './AvatarImage';

describe('getDiceBearAvatarUrl', () => {
    it('uses the site-wide bottts-neutral style and a stable encoded handle seed', () => {
        expect(getDiceBearAvatarUrl('cyph3r@node.example')).toBe(
            'https://api.dicebear.com/9.x/bottts-neutral/svg?seed=cyph3r%40node.example',
        );
    });

    it('uses the same seed for bare and qualified forms of a remote account', () => {
        expect(getDiceBearAvatarSeed('cyph3r', 'node.example')).toBe('cyph3r@node.example');
        expect(getDiceBearAvatarUrl('cyph3r', 'node.example')).toBe(
            getDiceBearAvatarUrl('cyph3r@node.example'),
        );
    });

    it('qualifies a local account with the runtime node domain', () => {
        expect(getDiceBearAvatarSeed('cyph3r', undefined, 'node.example')).toBe('cyph3r@node.example');
        expect(getDiceBearAvatarUrl('cyph3r', undefined, 'node.example')).toBe(
            getDiceBearAvatarUrl('cyph3r@node.example'),
        );
    });

    it('keeps an explicit remote domain ahead of the local node fallback', () => {
        expect(getDiceBearAvatarSeed('cyph3r', 'remote.example', 'local.example')).toBe(
            'cyph3r@remote.example',
        );
    });
});
