import { describe, expect, it } from 'vitest';

import { mergeMentionSuggestions, type MentionSuggestion } from './suggestions';

function suggestion(handle: string, isRemote = handle.includes('@')): MentionSuggestion {
    return {
        handle,
        displayName: null,
        avatarUrl: null,
        isRemote,
        nodeDomain: isRemote ? handle.split('@')[1] : null,
    };
}

describe('mergeMentionSuggestions', () => {
    it('surfaces remote matches even when local matches fill the result limit', () => {
        const local = ['alex', 'alice', 'alina', 'ally'].map((handle) => suggestion(handle));
        const remote = [
            suggestion('alex@remote.example'),
            suggestion('alice@another.example'),
        ];

        expect(mergeMentionSuggestions(local, remote, 4).map((item) => item.handle)).toEqual([
            'alex',
            'alex@remote.example',
            'alice',
            'alice@another.example',
        ]);
    });

    it('deduplicates canonical handles case-insensitively', () => {
        const remote = [
            suggestion('alice@remote.example'),
            suggestion('ALICE@REMOTE.EXAMPLE'),
        ];

        expect(mergeMentionSuggestions([], remote, 8).map((item) => item.handle)).toEqual([
            'alice@remote.example',
        ]);
    });

    it('fills unused remote slots with local matches', () => {
        const local = ['a', 'b', 'c'].map((handle) => suggestion(handle));

        expect(mergeMentionSuggestions(local, [], 2).map((item) => item.handle)).toEqual(['a', 'b']);
    });
});
