'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@/lib/contexts/AuthContext';
import { useAppDialog } from '@/lib/contexts/DialogContext';
import {
    BROWSER_NOTIFICATIONS_CHANGED_EVENT,
    browserNotificationsEnabledKey,
    browserNotificationPreferencesKey,
    browserNotificationsPromptedKey,
    browserNotificationsSeenKey,
    getBrowserNotificationContent,
    parseBrowserNotificationPreferences,
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
    const { showConfirm } = useAppDialog();
    const userId = user?.id;
    const [enabled, setEnabled] = useState(false);
    const [showPermissionPrompt, setShowPermissionPrompt] = useState(false);
    const promptedUserRef = useRef<string | null>(null);

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
        if (!userId) return;
        const timeout = window.setTimeout(() => {
            if (typeof Notification === 'undefined') return;
            const enabledKey = browserNotificationsEnabledKey(userId);
            const promptedKey = browserNotificationsPromptedKey(userId);

            if (Notification.permission === 'granted') {
                if (localStorage.getItem(enabledKey) === null) {
                    localStorage.setItem(enabledKey, 'true');
                    window.dispatchEvent(new Event(BROWSER_NOTIFICATIONS_CHANGED_EVENT));
                }
                localStorage.setItem(promptedKey, 'true');
                return;
            }

            if (Notification.permission === 'default'
                && localStorage.getItem(promptedKey) !== 'true') {
                setShowPermissionPrompt(true);
            }
        }, 1_200);
        return () => window.clearTimeout(timeout);
    }, [userId]);

    useEffect(() => {
        if (!enabled || !userId) return;

        let stopped = false;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        let activeController: AbortController | null = null;
        const seenKey = browserNotificationsSeenKey(userId);

        const poll = async () => {
            try {
                activeController = new AbortController();
                const response = await fetch('/api/notifications?unread=true&limit=20', {
                    cache: 'no-store',
                    signal: activeController.signal,
                });
                if (!response.ok || stopped) return;

                const data = await response.json();
                if (stopped) return;
                const notifications = (Array.isArray(data.notifications)
                    ? data.notifications
                    : []) as BrowserNotificationItem[];
                const remembered = readSeenNotifications(seenKey);
                const seen = new Set(remembered);
                const preferences = parseBrowserNotificationPreferences(
                    localStorage.getItem(browserNotificationPreferencesKey(userId)),
                );

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
                    if (stopped) return;
                    seen.add(item.id);
                    if (!preferences[item.type]) continue;
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
                if (!stopped) console.warn('[Notifications] Browser notification poll failed:', error);
            } finally {
                activeController = null;
                if (!stopped) timeout = setTimeout(poll, POLL_INTERVAL_MS);
            }
        };

        void poll();
        return () => {
            stopped = true;
            activeController?.abort();
            if (timeout) clearTimeout(timeout);
        };
    }, [enabled, user?.ageVerifiedAt, user?.nsfwEnabled, userId]);

    const finishPermissionPrompt = useCallback(async (requestPermission: boolean) => {
        if (!userId || typeof Notification === 'undefined') return;
        localStorage.setItem(browserNotificationsPromptedKey(userId), 'true');
        setShowPermissionPrompt(false);
        if (!requestPermission) return;

        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;
        localStorage.setItem(browserNotificationsEnabledKey(userId), 'true');
        window.dispatchEvent(new Event(BROWSER_NOTIFICATIONS_CHANGED_EVENT));
        new Notification('Synapsis notifications enabled', {
            body: 'You can customize them any time in Settings.',
            icon: '/api/favicon',
            tag: 'synapsis-notifications-enabled',
        });
    }, [userId]);

    useEffect(() => {
        if (!showPermissionPrompt || !userId || promptedUserRef.current === userId) return;
        promptedUserRef.current = userId;
        void showConfirm({
            title: 'Stay up to date',
            message: 'Allow browser notifications for new follows, replies, mentions, and reactions.',
            confirmLabel: 'Allow notifications',
            cancelLabel: 'Not now',
        }).then((requestPermission) => finishPermissionPrompt(requestPermission));
    }, [finishPermissionPrompt, showConfirm, showPermissionPrompt, userId]);

    return null;
}
