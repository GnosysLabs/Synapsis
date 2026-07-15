export const BROWSER_NOTIFICATIONS_CHANGED_EVENT = 'synapsis:browser-notifications-changed';

export type BrowserNotificationType = 'follow' | 'like' | 'repost' | 'mention' | 'reply';

export type BrowserNotificationPreferences = Record<BrowserNotificationType, boolean>;

export const DEFAULT_BROWSER_NOTIFICATION_PREFERENCES: BrowserNotificationPreferences = {
    follow: true,
    like: true,
    repost: true,
    mention: true,
    reply: true,
};

export interface BrowserNotificationItem {
    id: string;
    type: BrowserNotificationType;
    actor: {
        handle: string;
        displayName: string | null;
    } | null;
    post: {
        id: string;
        content: string | null;
    } | null;
}

export function browserNotificationsEnabledKey(userId: string): string {
    return `synapsis:browser-notifications:${userId}`;
}

export function browserNotificationsSeenKey(userId: string): string {
    return `synapsis:browser-notifications-seen:${userId}`;
}

export function browserNotificationsPromptedKey(userId: string): string {
    return `synapsis:browser-notifications-prompted:${userId}`;
}

export function browserNotificationPreferencesKey(userId: string): string {
    return `synapsis:browser-notification-preferences:${userId}`;
}

export function parseBrowserNotificationPreferences(value: string | null): BrowserNotificationPreferences {
    if (!value) return { ...DEFAULT_BROWSER_NOTIFICATION_PREFERENCES };
    try {
        const parsed = JSON.parse(value) as Partial<BrowserNotificationPreferences>;
        return Object.fromEntries(
            Object.entries(DEFAULT_BROWSER_NOTIFICATION_PREFERENCES)
                .map(([type, defaultValue]) => [type, parsed[type as BrowserNotificationType] ?? defaultValue]),
        ) as BrowserNotificationPreferences;
    } catch {
        return { ...DEFAULT_BROWSER_NOTIFICATION_PREFERENCES };
    }
}

function interactionText(type: BrowserNotificationItem['type']): string {
    switch (type) {
        case 'follow': return 'followed you';
        case 'like': return 'liked your post';
        case 'repost': return 'reposted your post';
        case 'mention': return 'mentioned you';
        case 'reply': return 'replied to your post';
    }
}

export function getBrowserNotificationContent(notification: BrowserNotificationItem): {
    title: string;
    body: string;
    url: string;
    tag: string;
} {
    const actorName = notification.actor?.displayName
        || notification.actor?.handle
        || 'Someone';
    const postContent = notification.post?.content?.replace(/\s+/g, ' ').trim();
    const body = postContent
        ? Array.from(postContent).slice(0, 140).join('')
        : 'Open Synapsis to view the notification.';

    return {
        title: `${actorName} ${interactionText(notification.type)}`,
        body,
        url: notification.post ? `/posts/${notification.post.id}` : '/notifications',
        tag: `synapsis-notification-${notification.id}`,
    };
}
