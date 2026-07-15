import { describe, expect, it } from 'vitest';

import {
    browserNotificationsEnabledKey,
    getBrowserNotificationContent,
    parseBrowserNotificationPreferences,
} from './browser';

describe('browser notification presentation', () => {
    it('scopes the opt-in to the signed-in account', () => {
        expect(browserNotificationsEnabledKey('user-1'))
            .toBe('synapsis:browser-notifications:user-1');
    });

    it('defaults every notification category on and preserves explicit choices', () => {
        expect(parseBrowserNotificationPreferences(null)).toEqual({
            follow: true,
            like: true,
            repost: true,
            mention: true,
            reply: true,
        });
        expect(parseBrowserNotificationPreferences('{"like":false}')).toMatchObject({
            follow: true,
            like: false,
            mention: true,
        });
    });

    it('links post interactions to the relevant post', () => {
        expect(getBrowserNotificationContent({
            id: 'notification-1',
            type: 'like',
            actor: { handle: 'alice', displayName: 'Alice' },
            post: { id: 'post-1', content: 'A post worth liking' },
        })).toEqual({
            title: 'Alice liked your post',
            body: 'A post worth liking',
            url: '/posts/post-1',
            tag: 'synapsis-notification-notification-1',
        });
    });

    it('uses the notifications page when there is no post', () => {
        expect(getBrowserNotificationContent({
            id: 'notification-2',
            type: 'follow',
            actor: { handle: 'bob', displayName: null },
            post: null,
        })).toMatchObject({
            title: 'bob followed you',
            url: '/notifications',
        });
    });
});
