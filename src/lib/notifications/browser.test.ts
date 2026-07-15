import { describe, expect, it } from 'vitest';

import {
    browserNotificationsEnabledKey,
    getBrowserNotificationContent,
} from './browser';

describe('browser notification presentation', () => {
    it('scopes the opt-in to the signed-in account', () => {
        expect(browserNotificationsEnabledKey('user-1'))
            .toBe('synapsis:browser-notifications:user-1');
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
