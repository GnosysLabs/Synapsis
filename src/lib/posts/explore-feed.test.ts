import { describe, expect, it } from 'vitest';
import { EXPLORE_FEED_API_TYPE, EXPLORE_TABS } from './explore-feed';

describe('Explore destination', () => {
    it('uses the curated cross-node feed', () => {
        expect(EXPLORE_FEED_API_TYPE).toBe('curated');
    });

    it('exposes only Explore and Users tabs', () => {
        expect(EXPLORE_TABS).toEqual([
            { id: 'explore', label: 'Explore' },
            { id: 'users', label: 'Users' },
        ]);
    });
});
