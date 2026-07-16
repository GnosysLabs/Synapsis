import { describe, expect, it } from 'vitest';

import {
    buildChatShareContinuationHref,
    buildChatShareHref,
    recentChatRecipients,
    uniqueChatRecipients,
} from './recipients';

describe('chat recipient picker helpers', () => {
    it('deduplicates recipients case-insensitively and excludes the viewer', () => {
        expect(uniqueChatRecipients([
            { handle: 'viewer', displayName: 'Me', avatarUrl: null },
            { handle: 'Alice', displayName: 'Alice', avatarUrl: '/alice.png' },
            { handle: 'alice', displayName: 'Duplicate', avatarUrl: null },
            { handle: 'bob@remote.example', displayName: null, avatarUrl: null, isRemote: true },
            { nope: true },
        ], '@viewer')).toEqual([
            { handle: 'Alice', displayName: 'Alice', avatarUrl: '/alice.png', isRemote: false },
            { handle: 'bob@remote.example', displayName: null, avatarUrl: null, isRemote: true },
        ]);
    });

    it('keeps conversation order when producing recent recipients', () => {
        expect(recentChatRecipients([
            { participant2: { handle: 'recent', displayName: 'Recent', avatarUrl: null } },
            { participant2: { handle: 'older', displayName: 'Older', avatarUrl: '/older.png' } },
        ])).toEqual([
            { handle: 'recent', displayName: 'Recent', avatarUrl: null, isRemote: false },
            { handle: 'older', displayName: 'Older', avatarUrl: '/older.png', isRemote: false },
        ]);
    });

    it('preserves the recipient and shared URL through both chat intent stages', () => {
        const sharedUrl = 'https://node.example/u/alice/posts/post-1?from=feed&mode=full';
        const href = buildChatShareHref('@bob@remote.example', sharedUrl);
        expect(new URL(href, 'https://node.example').searchParams.get('compose')).toBe('bob@remote.example');
        expect(new URL(href, 'https://node.example').searchParams.get('share')).toBe(sharedUrl);
        expect(new URL(buildChatShareContinuationHref(sharedUrl), 'https://node.example').searchParams.get('share')).toBe(sharedUrl);
        expect(buildChatShareContinuationHref(null)).toBe('/chat');
    });
});
