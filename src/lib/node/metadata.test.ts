import { describe, expect, it } from 'vitest';
import { buildNodeLinkMetadata } from './metadata';

describe('buildNodeLinkMetadata', () => {
    it('uses the node short description everywhere link previews read it', () => {
        const metadata = buildNodeLinkMetadata({
            name: 'Example Node',
            description: 'A concise description of this community.',
        });

        expect(metadata.description).toBe('A concise description of this community.');
        expect(metadata.openGraph).toMatchObject({
            title: 'Example Node',
            description: 'A concise description of this community.',
        });
        expect(metadata.twitter).toMatchObject({
            title: 'Example Node',
            description: 'A concise description of this community.',
        });
    });

    it('uses configured fallbacks when node branding is blank', () => {
        const metadata = buildNodeLinkMetadata(
            { name: ' ', description: ' ' },
            'Fallback Node',
            'Fallback description'
        );

        expect(metadata.description).toBe('Fallback description');
        expect(metadata.openGraph).toMatchObject({
            title: 'Fallback Node',
            description: 'Fallback description',
        });
    });
});
