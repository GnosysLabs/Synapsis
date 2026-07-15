'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bell, BellOff } from 'lucide-react';

import { ArrowLeftIcon } from '@/components/Icons';
import { useAuth } from '@/lib/contexts/AuthContext';
import {
    BROWSER_NOTIFICATIONS_CHANGED_EVENT,
    browserNotificationsEnabledKey,
} from '@/lib/notifications/browser';

type NotificationSupport = 'loading' | 'unsupported' | NotificationPermission;

export default function NotificationSettingsPage() {
    const { user } = useAuth();
    const userId = user?.id;
    const [support, setSupport] = useState<NotificationSupport>('loading');
    const [enabled, setEnabled] = useState(false);

    useEffect(() => {
        if (!userId) return;
        const timeout = window.setTimeout(() => {
            if (typeof Notification === 'undefined') {
                setSupport('unsupported');
                return;
            }
            setSupport(Notification.permission);
            setEnabled(localStorage.getItem(browserNotificationsEnabledKey(userId)) === 'true'
                && Notification.permission === 'granted');
        }, 0);
        return () => window.clearTimeout(timeout);
    }, [userId]);

    const enableNotifications = async () => {
        if (!userId || typeof Notification === 'undefined') return;
        const permission = Notification.permission === 'default'
            ? await Notification.requestPermission()
            : Notification.permission;
        setSupport(permission);
        if (permission !== 'granted') return;

        localStorage.setItem(browserNotificationsEnabledKey(userId), 'true');
        setEnabled(true);
        window.dispatchEvent(new Event(BROWSER_NOTIFICATIONS_CHANGED_EVENT));
        new Notification('Synapsis notifications enabled', {
            body: 'New interactions can now appear as browser notifications.',
            icon: '/api/favicon',
            tag: 'synapsis-notifications-enabled',
        });
    };

    const disableNotifications = () => {
        if (!userId) return;
        localStorage.removeItem(browserNotificationsEnabledKey(userId));
        setEnabled(false);
        window.dispatchEvent(new Event(BROWSER_NOTIFICATIONS_CHANGED_EVENT));
    };

    const statusText = support === 'unsupported'
        ? 'Browser notifications are not supported on this device.'
        : support === 'denied'
            ? 'Notifications are blocked in your browser settings.'
            : enabled
                ? 'Browser notifications are on for this account and device.'
                : 'Get notified about new follows, likes, reposts, mentions, and replies.';

    return (
        <div style={{ maxWidth: '600px', margin: '0 auto', padding: '24px 16px 64px' }}>
            <header style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '32px' }}>
                <Link href="/settings" style={{ color: 'var(--foreground)' }} aria-label="Back to settings">
                    <ArrowLeftIcon />
                </Link>
                <div>
                    <h1 style={{ fontSize: '24px', fontWeight: 700 }}>Notifications</h1>
                    <p style={{ color: 'var(--foreground-tertiary)', fontSize: '14px' }}>
                        Control notifications on this device
                    </p>
                </div>
            </header>

            <div className="card" style={{ padding: '20px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                    {enabled ? <Bell size={22} /> : <BellOff size={22} />}
                    <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600 }}>
                            {enabled ? 'Browser notifications on' : 'Browser notifications off'}
                        </div>
                        <p style={{ color: 'var(--foreground-secondary)', fontSize: '14px', lineHeight: 1.5, marginTop: '6px' }}>
                            {statusText}
                        </p>
                    </div>
                </div>

                {support !== 'loading' && support !== 'unsupported' && support !== 'denied' && (
                    <button
                        type="button"
                        className={`btn ${enabled ? 'btn-ghost' : 'btn-primary'}`}
                        onClick={enabled ? disableNotifications : enableNotifications}
                        style={{ marginTop: '18px' }}
                    >
                        {enabled ? 'Turn Off' : 'Enable Browser Notifications'}
                    </button>
                )}
                <p style={{ color: 'var(--foreground-tertiary)', fontSize: '12px', lineHeight: 1.5, marginTop: '14px' }}>
                    Notifications appear while Synapsis is open in a browser tab. Permission and this setting apply only to this device.
                </p>
            </div>
        </div>
    );
}
