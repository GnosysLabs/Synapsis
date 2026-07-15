import { describe, expect, it } from 'vitest';
import { DEFAULT_HOME_FEED, HOME_FEED_LABELS } from './home-feed';

describe('home feed defaults', () => {
    it('opens on the For You feed by default', () => {
        expect(DEFAULT_HOME_FEED).toBe('curated');
        expect(HOME_FEED_LABELS[DEFAULT_HOME_FEED]).toBe('For You');
    });

    it('retains Following as the chronological alternative', () => {
        expect(HOME_FEED_LABELS.following).toBe('Following');
    });
});
