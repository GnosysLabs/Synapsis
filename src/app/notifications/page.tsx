'use client';

import { useState, useEffect } from 'react';
import { BellIcon } from '@/components/Icons';
import Link from 'next/link';
import { useAuth } from '@/lib/contexts/AuthContext';
import { getProfilePath } from '@/lib/utils/handle';
import { AvatarImage } from '@/components/AvatarImage';
import { getNotificationPostPreview } from '@/lib/notifications/post-preview';
import { displayAccountAddress } from '@/lib/identity/account-address';
import { StuffboxBadge } from '@/components/StuffboxBadge';
import type { StuffboxBadge as StuffboxBadgeValue } from '@/lib/types';

interface NotificationActor {
    id: string;
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    isNsfw?: boolean;
    nodeIsNsfw?: boolean;
    nodeDomain?: string | null;
    stuffboxBadge?: StuffboxBadgeValue | null;
}

interface NotificationPost {
    id: string;
    content: string | null;
    authorHandle: string | null;
    media: Array<{
        url: string;
        mimeType: string | null;
        altText: string | null;
    }>;
    linkPreviewImage: string | null;
    sensitiveRestricted?: boolean;
}

interface Notification {
    id: string;
    type: 'follow' | 'like' | 'repost' | 'mention' | 'reply';
    createdAt: string;
    readAt: string | null;
    actor: NotificationActor | null;
    post: NotificationPost | null;
}

export default function NotificationsPage() {
    const { loading: authLoading } = useAuth();
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (authLoading) {
            return;
        }
        fetchNotifications();
    }, [authLoading]);

    const fetchNotifications = async () => {
        try {
            const res = await fetch('/api/notifications');
            if (!res.ok) {
                if (res.status === 401) {
                    setError('Please log in to view notifications');
                    return;
                }
                throw new Error('Failed to fetch notifications');
            }
            const data = await res.json();
            setNotifications(data.notifications || []);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load notifications');
        } finally {
            setLoading(false);
        }
    };

    const markAllRead = async () => {
        try {
            const res = await fetch('/api/notifications', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ all: true }),
            });
            if (!res.ok) {
                throw new Error('Failed to mark notifications as read');
            }
            setNotifications(prev => prev.map(n => ({ ...n, readAt: new Date().toISOString() })));
            window.dispatchEvent(new Event('synapsis:notifications-updated'));
        } catch (err) {
            console.error('Failed to mark notifications as read:', err);
        }
    };

    const getNotificationText = (notification: Notification) => {
        switch (notification.type) {
            case 'follow':
                return 'followed you';
            case 'like':
                return 'liked your post';
            case 'repost':
                return 'reposted your post';
            case 'mention':
                return 'mentioned you';
            case 'reply':
                return 'replied to your post';
            default:
                return 'interacted with you';
        }
    };

    const formatTime = (dateStr: string) => {
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return 'just now';
        if (diffMins < 60) return `${diffMins}m`;
        if (diffHours < 24) return `${diffHours}h`;
        if (diffDays < 7) return `${diffDays}d`;
        return date.toLocaleDateString();
    };

    return (
        <div className="notifications-page">
            <header style={{
                padding: '16px',
                borderBottom: '1px solid var(--border)',
                background: 'var(--background)',
                position: 'sticky',
                top: 0,
                zIndex: 10,
                backdropFilter: 'blur(12px)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
            }}>
                <h1 style={{ fontSize: '18px', fontWeight: 600 }}>Notifications</h1>
                {notifications.length > 0 && (
                    <button
                        onClick={markAllRead}
                        style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--accent)',
                            cursor: 'pointer',
                            fontSize: '14px',
                        }}
                    >
                        Mark all read
                    </button>
                )}
            </header>

            {loading ? (
                <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>
                    Loading...
                </div>
            ) : error ? (
                <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>
                    {error}
                </div>
            ) : notifications.length === 0 ? (
                <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>
                    <div style={{ marginBottom: '16px', display: 'flex', justifyContent: 'center' }}>
                        <div style={{ width: 40, height: 40, background: 'var(--background-secondary)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <BellIcon />
                        </div>
                    </div>
                    <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px', color: 'var(--foreground)' }}>No notifications yet</h3>
                    <p style={{ fontSize: '14px' }}>When you get interactions, they&apos;ll show up here.</p>
                </div>
            ) : (
                <div>
                    {notifications.map((notification) => (
                        <NotificationItem
                            key={notification.id}
                            notification={notification}
                            getNotificationText={getNotificationText}
                            formatTime={formatTime}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function NotificationItem({
    notification,
    getNotificationText,
    formatTime,
}: {
    notification: Notification;
    getNotificationText: (n: Notification) => string;
    formatTime: (d: string) => string;
}) {
    const isUnread = !notification.readAt;
    const actor = notification.actor;
    const actorProfilePath = actor ? getProfilePath(actor.handle, actor.nodeDomain) : '#';
    const postPreview = notification.post
        ? getNotificationPostPreview(notification.post)
        : null;

    return (
        <div
            style={{
                padding: '12px 16px',
                borderBottom: '1px solid var(--border)',
                background: isUnread ? 'var(--background-secondary)' : 'transparent',
                display: 'flex',
                gap: '12px',
                alignItems: 'flex-start',
            }}
        >
            <Link href={actorProfilePath} style={{ flexShrink: 0 }}>
                <div className="avatar">
                    <AvatarImage
                        avatarUrl={actor?.avatarUrl}
                        seed={actor?.handle || 'unknown'}
                        nodeDomain={actor?.nodeDomain}
                        isNsfw={actor?.isNsfw}
                        nodeIsNsfw={actor?.nodeIsNsfw}
                        alt={actor?.displayName || actor?.handle || 'Unknown user'}
                    />
                </div>
            </Link>

            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: '4px', alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <Link
                        href={actorProfilePath}
                        style={{ fontWeight: 600, color: 'var(--foreground)', textDecoration: 'none' }}
                    >
                        {actor?.displayName || (actor ? displayAccountAddress(actor.handle) : 'Someone')} {actor && (
                            <span style={{ fontWeight: 400, color: 'var(--foreground-tertiary)' }}>
                                {displayAccountAddress(actor.handle)}
                            </span>
                        )}
                    </Link>
                    <StuffboxBadge badge={actor?.stuffboxBadge} linked />
                    <span style={{ color: 'var(--foreground-secondary)' }}>
                        {getNotificationText(notification)}
                    </span>
                    <span style={{ color: 'var(--foreground-tertiary)', fontSize: '13px' }}>
                        · {formatTime(notification.createdAt)}
                    </span>
                </div>

                {notification.post && (
                    <Link
                        href={`/posts/${notification.post.id}`}
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '8px',
                            width: 'fit-content',
                            maxWidth: '100%',
                            marginTop: '10px',
                            padding: '5px 10px 5px 5px',
                            background: 'var(--background)',
                            border: '1px solid var(--border)',
                            borderRadius: '10px',
                            color: 'var(--foreground-secondary)',
                            fontSize: '13px',
                            lineHeight: 1.3,
                            textDecoration: 'none',
                            overflow: 'hidden',
                        }}
                        aria-label={`View post: ${notification.post.sensitiveRestricted ? 'Sensitive post hidden' : postPreview?.label || 'View post'}`}
                    >
                        {postPreview?.imageUrl && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                                src={postPreview.imageUrl}
                                alt={postPreview.imageAlt}
                                style={{
                                    width: 48,
                                    height: 48,
                                    borderRadius: '7px',
                                    objectFit: 'cover',
                                    flexShrink: 0,
                                }}
                            />
                        )}
                        <span style={{
                            minWidth: 0,
                            maxWidth: '320px',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                        }}>
                            {notification.post.sensitiveRestricted
                                ? 'Sensitive post hidden'
                                : postPreview?.label || 'View post'}
                        </span>
                    </Link>
                )}
            </div>

            {isUnread && (
                <div
                    style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: 'var(--accent)',
                        flexShrink: 0,
                        marginTop: '6px',
                    }}
                />
            )}
        </div>
    );
}
