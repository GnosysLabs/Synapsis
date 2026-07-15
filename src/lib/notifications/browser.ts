export const BROWSER_NOTIFICATIONS_CHANGED_EVENT = 'synapsis:browser-notifications-changed';

export interface BrowserNotificationItem {
    id: string;
    type: 'follow' | 'like' | 'repost' | 'mention' | 'reply';
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
