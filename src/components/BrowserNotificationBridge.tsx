'use client';

import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';

import { useAuth } from '@/lib/contexts/AuthContext';
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
    const userId = user?.id;
    const [enabled, setEnabled] = useState(false);
    const [showPermissionPrompt, setShowPermissionPrompt] = useState(false);

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

    const finishPermissionPrompt = async (requestPermission: boolean) => {
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
    };

    if (!showPermissionPrompt) return null;

    return (
        <div
            role="dialog"
            aria-labelledby="browser-notification-prompt-title"
            style={{
                position: 'fixed',
                left: '50%',
                bottom: '24px',
                transform: 'translateX(-50%)',
                width: 'min(calc(100% - 32px), 420px)',
                padding: '18px',
                background: 'var(--background)',
                border: '1px solid var(--border)',
                borderRadius: '14px',
                boxShadow: '0 16px 48px rgba(0, 0, 0, 0.35)',
                zIndex: 1000,
            }}
        >
            <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                <Bell size={22} style={{ flexShrink: 0, marginTop: '2px' }} />
                <div>
                    <div id="browser-notification-prompt-title" style={{ fontWeight: 650 }}>
                        Stay up to date
                    </div>
                    <p style={{ color: 'var(--foreground-secondary)', fontSize: '14px', lineHeight: 1.45, marginTop: '5px' }}>
                        Allow browser notifications for new follows, replies, mentions, and reactions.
                    </p>
                </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
                <button type="button" className="btn btn-ghost" onClick={() => void finishPermissionPrompt(false)}>
                    Not Now
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void finishPermissionPrompt(true)}>
                    Allow Notifications
                </button>
            </div>
        </div>
    );
}
