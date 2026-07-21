import { describe, expect, it } from 'vitest';
import {
    ANONYMOUS_APP_DESTINATION,
    ANONYMOUS_HOME_FEED,
    DEFAULT_HOME_FEED,
    HOME_FEED_API_TYPES,
    HOME_FEED_LABELS,
} from './home-feed';

describe('home feed defaults', () => {
    it('opens signed-in Home on For You by default', () => {
        expect(DEFAULT_HOME_FEED).toBe('forYou');
        expect(HOME_FEED_LABELS[DEFAULT_HOME_FEED]).toBe('For You');
        expect(HOME_FEED_API_TYPES[DEFAULT_HOME_FEED]).toBe('for-you');
    });

    it('maps Following to the personalized home timeline', () => {
        expect(HOME_FEED_LABELS.following).toBe('Following');
        expect(HOME_FEED_API_TYPES.following).toBe('home');
    });

    it('keeps transparent Node and Following alternatives beside For You', () => {
        expect(Object.keys(HOME_FEED_LABELS)).toEqual(['forYou', 'node', 'following']);
        expect(Object.values(HOME_FEED_API_TYPES)).toEqual(['for-you', 'local', 'home']);
    });

    it('sends signed-out visitors to the node feed', () => {
        expect(ANONYMOUS_HOME_FEED).toBe('node');
        expect(ANONYMOUS_APP_DESTINATION).toBe('/');
    });

});
