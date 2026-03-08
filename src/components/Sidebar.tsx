'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/contexts/AuthContext';
import { HomeIcon, SearchIcon, BellIcon, UserIcon, ShieldIcon, SettingsIcon, BotIcon } from './Icons';
import { useFormattedHandle } from '@/lib/utils/handle';
import { LogOut, Settings2 } from 'lucide-react';
// import { IdentityUnlockPrompt } from './IdentityUnlockPrompt'; // Moved to LayoutWrapper

export function Sidebar() {
    const { user, isAdmin, logout } = useAuth();
    const pathname = usePathname();
    const router = useRouter();
    const [customLogoUrl, setCustomLogoUrl] = useState<string | null | undefined>(undefined);
    const [unreadCount, setUnreadCount] = useState(0);
    const [unreadChatCount, setUnreadChatCount] = useState(0);
    const [loggingOut, setLoggingOut] = useState(false);
    const formattedHandle = user ? useFormattedHandle(user.handle) : '';

    useEffect(() => {
        fetch('/api/node')
            .then(res => res.json())
            .then(data => {
                setCustomLogoUrl(data.logoUrl || null);
            })
            .catch(() => {
                setCustomLogoUrl(null);
            });
    }, []);

    const fetchUnreadNotifications = useCallback(() => {
        fetch('/api/notifications?unread=true&limit=50')
            .then(res => res.json())
            .then(data => {
                setUnreadCount(data.notifications?.length || 0);
            })
            .catch(() => { });
    }, []);

    const fetchUnreadChats = useCallback(() => {
        fetch('/api/chat/unread')
            .then(res => res.json())
            .then(data => {
                setUnreadChatCount(data.unreadCount || 0);
            })
            .catch(() => { });
    }, []);

    // Fetch unread notification count
    useEffect(() => {
        if (!user) return;

        fetchUnreadNotifications();

        const handleUnreadRefresh = () => {
            fetchUnreadNotifications();
        };

        window.addEventListener('synapsis:notifications-updated', handleUnreadRefresh);
        // Poll every 30 seconds
        const interval = setInterval(fetchUnreadNotifications, 30000);
        return () => {
            clearInterval(interval);
            window.removeEventListener('synapsis:notifications-updated', handleUnreadRefresh);
        };
    }, [user, fetchUnreadNotifications]);

    // Fetch unread chat count
    useEffect(() => {
        if (!user) return;

        fetchUnreadChats();

        const handleUnreadRefresh = () => {
            fetchUnreadChats();
        };

        window.addEventListener('synapsis:chat-updated', handleUnreadRefresh);
        // Poll every 10 seconds
        const interval = setInterval(fetchUnreadChats, 10000);
        return () => {
            clearInterval(interval);
            window.removeEventListener('synapsis:chat-updated', handleUnreadRefresh);
        };
    }, [user, fetchUnreadChats]);

    // Home is exact match
    const isHome = pathname === '/';

    const handleLogout = async () => {
        if (loggingOut) return;

        setLoggingOut(true);
        try {
            await logout();
            window.location.href = '/explore';
        } catch (error) {
            console.error('Logout failed:', error);
            setLoggingOut(false);
        }
    };

    return (
        <aside className="sidebar">
            <Link href={user ? "/" : "/explore"} className="logo" style={{ minHeight: '42px' }}>
                {customLogoUrl === undefined ? null : customLogoUrl ? (
                    <img src={customLogoUrl} alt="Logo" style={{ maxWidth: '200px', maxHeight: '50px', objectFit: 'contain' }} />
                ) : (
                    <Image src="/logotext.svg" alt="Synapsis" width={185} height={42} priority />
                )}
            </Link>
            <nav>
                {user && (
                    <Link href="/" className={`nav-item ${isHome ? 'active' : ''}`} title="Home">
                        <HomeIcon />
                        <span>Home</span>
                    </Link>
                )}
                <Link href="/explore" className={`nav-item ${pathname?.startsWith('/explore') ? 'active' : ''}`} title="Explore">
                    <SearchIcon />
                    <span>Explore</span>
                </Link>
                {user && (
                    <Link href="/notifications" className={`nav-item ${pathname?.startsWith('/notifications') ? 'active' : ''}`} title="Notifications">
                        <BellIcon />
                        <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span className="nav-label">Notifications</span>
                            {unreadCount > 0 && (
                                <span style={{
                                    width: '8px',
                                    height: '8px',
                                    background: 'var(--error)',
                                    borderRadius: '50%',
                                    flexShrink: 0
                                }} className="notification-dot" />
                            )}
                        </span>
                    </Link>
                )}
                {user && (
                    <Link href="/chat" className={`nav-item ${pathname?.startsWith('/chat') ? 'active' : ''}`} title="Chat">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                        </svg>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span className="nav-label">Chat</span>
                            {unreadChatCount > 0 && (
                                <span style={{
                                    width: '8px',
                                    height: '8px',
                                    background: 'var(--error)',
                                    borderRadius: '50%',
                                    flexShrink: 0
                                }} className="notification-dot" />
                            )}
                        </span>
                    </Link>
                )}
                {user && (
                    <Link href="/bots" className={`nav-item ${pathname?.startsWith('/bots') ? 'active' : ''}`} title="Bots">
                        <BotIcon />
                        <span>Bots</span>
                    </Link>
                )}
                {user ? (
                    <Link href={`/u/${user.handle}`} className={`nav-item ${pathname === '/u/' + user.handle ? 'active' : ''}`} title="Profile">
                        <UserIcon />
                        <span>Profile</span>
                    </Link>
                ) : (
                    <Link href="/login" className={`nav-item ${pathname === '/login' ? 'active' : ''}`} title="Login">
                        <UserIcon />
                        <span>Login</span>
                    </Link>
                )}
                {isAdmin && (
                    <Link href="/moderation" className={`nav-item ${pathname?.startsWith('/moderation') ? 'active' : ''}`} title="Moderation">
                        <ShieldIcon />
                        <span>Moderation</span>
                    </Link>
                )}
                {isAdmin && (
                    <Link href="/admin" className={`nav-item ${pathname?.startsWith('/admin') ? 'active' : ''}`} title="Admin">
                        <Settings2 size={24} />
                        <span>Admin</span>
                    </Link>
                )}
                {user && (
                    <Link href="/settings" className={`nav-item ${pathname?.startsWith('/settings') ? 'active' : ''}`} title="Settings">
                        <SettingsIcon />
                        <span>Settings</span>
                    </Link>
                )}
            </nav>
            {user && (
                <div style={{ marginTop: 'auto', paddingTop: '16px' }} className="sidebar-user-info">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0, marginBottom: '12px' }}>
                        <div className="avatar avatar-sm" style={{ flexShrink: 0 }}>
                            {user.avatarUrl ? (
                                <img src={user.avatarUrl} alt={user.displayName} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                            ) : (
                                (user.displayName?.charAt(0) || user.handle.charAt(0)).toUpperCase()
                            )}
                        </div>
                        <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontWeight: 600, fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.displayName}</div>
                            <div style={{ color: 'var(--foreground-tertiary)', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{formattedHandle}</div>
                        </div>
                    </div>

                    <button
                        onClick={handleLogout}
                        disabled={loggingOut}
                        className="btn btn-ghost"
                        style={{
                            width: '100%',
                            justifyContent: 'flex-start',
                            gap: '12px',
                            padding: '10px 12px',
                            fontSize: '14px',
                        }}
                    >
                        <LogOut size={20} />
                        <span>{loggingOut ? 'Signing out...' : 'Sign out'}</span>
                    </button>
                </div>
            )}

            {/* Identity Unlock Prompt Modal is now handled in LayoutWrapper */}
        </aside>
    );
}
