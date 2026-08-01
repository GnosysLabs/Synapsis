import { describe, expect, it } from 'vitest';
import {
    ANONYMOUS_APP_DESTINATION,
    ANONYMOUS_HOME_FEED,
    DEFAULT_HOME_FEED,
    HOME_FEED_API_TYPES,
    HOME_FEED_LABELS,
} from './home-feed';

describe('home feed defaults', () => {
    it('opens signed-in Home on the joined node by default', () => {
        expect(DEFAULT_HOME_FEED).toBe('node');
        expect(HOME_FEED_LABELS[DEFAULT_HOME_FEED]).toBe('Node');
        expect(HOME_FEED_API_TYPES[DEFAULT_HOME_FEED]).toBe('local');
    });

    it('maps Following to the personalized home timeline', () => {
        expect(HOME_FEED_LABELS.following).toBe('Following');
        expect(HOME_FEED_API_TYPES.following).toBe('home');
    });

    it('places For You between Node and Following', () => {
        expect(Object.keys(HOME_FEED_LABELS)).toEqual(['node', 'forYou', 'following']);
        expect(Object.values(HOME_FEED_API_TYPES)).toEqual(['local', 'for-you', 'home']);
    });

    it('sends signed-out visitors to the node feed', () => {
        expect(ANONYMOUS_HOME_FEED).toBe('node');
        expect(ANONYMOUS_APP_DESTINATION).toBe('/');
    });

});
