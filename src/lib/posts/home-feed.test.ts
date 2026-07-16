import { describe, expect, it } from 'vitest';
import { DEFAULT_HOME_FEED, HOME_FEED_API_TYPES, HOME_FEED_LABELS } from './home-feed';

describe('home feed defaults', () => {
    it('opens on the local node feed by default', () => {
        expect(DEFAULT_HOME_FEED).toBe('node');
        expect(HOME_FEED_LABELS[DEFAULT_HOME_FEED]).toBe('Node');
        expect(HOME_FEED_API_TYPES[DEFAULT_HOME_FEED]).toBe('local');
    });

    it('maps Following to the personalized home timeline', () => {
        expect(HOME_FEED_LABELS.following).toBe('Following');
        expect(HOME_FEED_API_TYPES.following).toBe('home');
    });

    it('rebrands the cross-node curated timeline as Explore', () => {
        expect(HOME_FEED_LABELS.explore).toBe('Explore');
        expect(HOME_FEED_API_TYPES.explore).toBe('curated');
    });
});
