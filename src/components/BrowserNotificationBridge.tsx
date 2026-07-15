'use client';

import { useEffect, useState } from 'react';

import { useAuth } from '@/lib/contexts/AuthContext';
import {
    BROWSER_NOTIFICATIONS_CHANGED_EVENT,
    browserNotificationsEnabledKey,
    browserNotificationsSeenKey,
    getBrowserNotificationContent,
    type BrowserNotificationItem,
} from '@/lib/notifications/browser';

const POLL_INTERVAL_MS = 30_000;
const MAX_REMEMBERED_NOTIFICATIONS = 100;

function readSeenNotifications(key: string): string[] {
    try {
        const parsed = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(parsed)
            ? parsed.filter((value): value is string => typeof value === 'string')
            : [];
    } catch {
        return [];
    }
}

export function BrowserNotificationBridge() {
    const { user } = useAuth();
    const userId = user?.id;
    const [enabled, setEnabled] = useState(false);

    useEffect(() => {
        const syncEnabledState = () => {
            setEnabled(Boolean(userId)
                && typeof Notification !== 'undefined'
                && Notification.permission === 'granted'
                && localStorage.getItem(browserNotificationsEnabledKey(userId!)) === 'true');
        };

        syncEnabledState();
        window.addEventListener(BROWSER_NOTIFICATIONS_CHANGED_EVENT, syncEnabledState);
        window.addEventListener('storage', syncEnabledState);
        return () => {
            window.removeEventListener(BROWSER_NOTIFICATIONS_CHANGED_EVENT, syncEnabledState);
            window.removeEventListener('storage', syncEnabledState);
        };
    }, [userId]);

    useEffect(() => {
        if (!enabled || !userId) return;

        let stopped = false;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        const seenKey = browserNotificationsSeenKey(userId);

        const poll = async () => {
            try {
                const response = await fetch('/api/notifications?unread=true&limit=20', {
                    cache: 'no-store',
                });
                if (!response.ok || stopped) return;

                const data = await response.json();
                const notifications = (Array.isArray(data.notifications)
                    ? data.notifications
                    : []) as BrowserNotificationItem[];
                const remembered = readSeenNotifications(seenKey);
                const seen = new Set(remembered);

                // Enabling notifications should not dump the user's entire unread
                // backlog into the OS. The first poll establishes a baseline.
                if (!localStorage.getItem(seenKey)) {
                    localStorage.setItem(
                        seenKey,
                        JSON.stringify(notifications.map((notification) => notification.id)),
                    );
                    return;
                }

                const unseen = notifications
                    .filter((notification) => !seen.has(notification.id))
                    .reverse();

                for (const item of unseen) {
                    seen.add(item.id);
                    const content = getBrowserNotificationContent(item);
                    const browserNotification = new Notification(content.title, {
                        body: content.body,
                        icon: '/api/favicon',
                        tag: content.tag,
                    });
                    browserNotification.onclick = () => {
                        window.focus();
                        window.location.assign(content.url);
                        browserNotification.close();
                    };
                }

                if (unseen.length > 0) {
                    localStorage.setItem(
                        seenKey,
                        JSON.stringify([...seen].slice(-MAX_REMEMBERED_NOTIFICATIONS)),
                    );
                }
            } catch (error) {
                console.warn('[Notifications] Browser notification poll failed:', error);
            } finally {
                if (!stopped) timeout = setTimeout(poll, POLL_INTERVAL_MS);
            }
        };

        void poll();
        return () => {
            stopped = true;
            if (timeout) clearTimeout(timeout);
        };
    }, [enabled, userId]);

    return null;
}
