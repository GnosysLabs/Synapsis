'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/contexts/AuthContext';
import { HomeIcon, SearchIcon, BellIcon, UserIcon, ShieldIcon, SettingsIcon, BotIcon } from './Icons';
import { useFormattedHandle } from '@/lib/utils/handle';
import { Check, ChevronDown, LogOut, Plus, Settings2 } from 'lucide-react';
import { AuthScreen } from '@/app/login/page';
// import { IdentityUnlockPrompt } from './IdentityUnlockPrompt'; // Moved to LayoutWrapper

function shortHandle(handle: string) {
    const cleanHandle = handle.startsWith('@') ? handle.slice(1) : handle;
    return `@${cleanHandle.split('@')[0]}`;
}

export function Sidebar() {
    const { user, accounts, isAdmin, logout, switchAccount } = useAuth();
    const pathname = usePathname();
    const router = useRouter();
    const [customLogoUrl, setCustomLogoUrl] = useState<string | null | undefined>(undefined);
    const [unreadCount, setUnreadCount] = useState(0);
    const [unreadChatCount, setUnreadChatCount] = useState(0);
    const [loggingOut, setLoggingOut] = useState(false);
    const [switchingAccountId, setSwitchingAccountId] = useState<string | null>(null);
    const [accountMenuOpen, setAccountMenuOpen] = useState(false);
    const [showAuthModal, setShowAuthModal] = useState(false);
    const accountMenuRef = useRef<HTMLDivElement | null>(null);
    const accountTriggerRef = useRef<HTMLButtonElement | null>(null);
    const accountPopupRef = useRef<HTMLDivElement | null>(null);
    const [accountPopupStyle, setAccountPopupStyle] = useState<React.CSSProperties | null>(null);
    const formattedHandle = user ? shortHandle(user.handle) : '';

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
        if (loggingOut || !user) return;

        setLoggingOut(true);
        try {
            const isLastAccount = accounts.length <= 1;
            await logout(user.id);
            setAccountMenuOpen(false);

            if (isLastAccount) {
                window.location.href = '/explore';
            } else {
                router.refresh();
            }
        } catch (error) {
            console.error('Logout failed:', error);
            setLoggingOut(false);
        }
    };

    const handleSwitchAccount = async (userId: string) => {
        if (switchingAccountId || userId === user?.id) {
            setAccountMenuOpen(false);
            return;
        }

        setSwitchingAccountId(userId);
        try {
            await switchAccount(userId);
            setAccountMenuOpen(false);
            router.refresh();
        } catch (error) {
            console.error('Account switch failed:', error);
        } finally {
            setSwitchingAccountId(null);
        }
    };

    const updateAccountPopupPosition = useCallback(() => {
        if (!accountTriggerRef.current) return;

        const rect = accountTriggerRef.current.getBoundingClientRect();
        const popupWidth = 320;
        const viewportPadding = 16;
        const left = Math.min(
            rect.left,
            window.innerWidth - popupWidth - viewportPadding
        );
        const bottom = window.innerHeight - rect.top + 12;

        setAccountPopupStyle({
            position: 'fixed',
            left: `${Math.max(viewportPadding, left)}px`,
            bottom: `${bottom}px`,
            width: `${popupWidth}px`,
            maxWidth: `min(${popupWidth}px, calc(100vw - 32px))`,
            background: 'rgba(0, 0, 0, 0.96)',
            border: '1px solid var(--border)',
            borderRadius: '18px',
            boxShadow: '0 20px 60px rgba(0, 0, 0, 0.58)',
            overflow: 'hidden',
            zIndex: 10000,
            backdropFilter: 'blur(18px)',
        });
    }, []);

    useEffect(() => {
        if (!accountMenuOpen) return;

        updateAccountPopupPosition();

        const handlePointerDown = (event: MouseEvent) => {
            const target = event.target as Node;
            const clickedTrigger = accountMenuRef.current?.contains(target);
            const clickedPopup = accountPopupRef.current?.contains(target);

            if (!clickedTrigger && !clickedPopup) {
                setAccountMenuOpen(false);
            }
        };

        const handleWindowChange = () => {
            updateAccountPopupPosition();
        };

        window.addEventListener('mousedown', handlePointerDown);
        window.addEventListener('resize', handleWindowChange);
        window.addEventListener('scroll', handleWindowChange, true);

        return () => {
            window.removeEventListener('mousedown', handlePointerDown);
            window.removeEventListener('resize', handleWindowChange);
            window.removeEventListener('scroll', handleWindowChange, true);
        };
    }, [accountMenuOpen, updateAccountPopupPosition]);

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
                <div
                    ref={accountMenuRef}
                    style={{ marginTop: 'auto', paddingTop: '16px', position: 'relative' }}
                    className="sidebar-user-info"
                >
                    {accountMenuOpen && accountPopupStyle && typeof document !== 'undefined' && createPortal(
                        <div style={{
                            ...accountPopupStyle,
                        }}>
                            <div ref={accountPopupRef}>
                            <div style={{ padding: '8px 0' }}>
                                {accounts.map((account) => {
                                    const isActive = account.id === user.id;
                                    const isSwitching = switchingAccountId === account.id;

                                    return (
                                        <button
                                            key={account.id}
                                            onClick={() => void handleSwitchAccount(account.id)}
                                            disabled={isSwitching || loggingOut}
                                            style={{
                                                width: '100%',
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '14px',
                                                padding: '14px 18px',
                                                background: 'transparent',
                                                color: 'var(--foreground)',
                                                border: 'none',
                                                cursor: 'pointer',
                                                textAlign: 'left',
                                            }}
                                        >
                                            <div className="avatar avatar-sm" style={{ flexShrink: 0 }}>
                                                {account.avatarUrl ? (
                                                    <img src={account.avatarUrl} alt={account.displayName || account.handle} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                                ) : (
                                                    (account.displayName?.charAt(0) || account.handle.charAt(0)).toUpperCase()
                                                )}
                                            </div>
                                            <div style={{ minWidth: 0, flex: 1, display: 'grid', gap: '2px' }}>
                                                <div style={{ fontWeight: 700, fontSize: '15px', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                    {account.displayName || account.handle}
                                                </div>
                                                <div style={{ color: 'var(--foreground-secondary)', fontSize: '13px', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                    {shortHandle(account.handle)}
                                                </div>
                                            </div>
                                            <div style={{ width: '24px', display: 'flex', justifyContent: 'center', color: 'var(--accent)', flexShrink: 0 }}>
                                                {isActive ? <Check size={18} /> : isSwitching ? <span style={{ fontSize: '12px' }}>...</span> : null}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>

                            <div style={{ borderTop: '1px solid var(--border)', padding: '6px 0' }}>
                                <button
                                    onClick={() => {
                                        setAccountMenuOpen(false);
                                        setShowAuthModal(true);
                                    }}
                                    style={{
                                        width: '100%',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '14px',
                                        padding: '14px 18px',
                                        background: 'transparent',
                                        color: 'var(--foreground)',
                                        border: 'none',
                                        cursor: 'pointer',
                                        textAlign: 'left',
                                        fontWeight: 600,
                                        whiteSpace: 'nowrap',
                                    }}
                                >
                                    <Plus size={18} style={{ flexShrink: 0 }} />
                                    <span>Add an existing account</span>
                                </button>

                                <button
                                    onClick={handleLogout}
                                    disabled={loggingOut}
                                    style={{
                                        width: '100%',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '14px',
                                        padding: '14px 18px',
                                        background: 'transparent',
                                        color: 'var(--foreground)',
                                        border: 'none',
                                        cursor: 'pointer',
                                        textAlign: 'left',
                                        fontWeight: 600,
                                        whiteSpace: 'nowrap',
                                    }}
                                >
                                    <LogOut size={18} style={{ flexShrink: 0 }} />
                                    <span>{loggingOut ? 'Signing out...' : `Sign out ${formattedHandle}`}</span>
                                </button>
                            </div>
                            </div>
                        </div>,
                        document.body
                    )}

                    <button
                        ref={accountTriggerRef}
                        onClick={() => setAccountMenuOpen(open => !open)}
                        className="btn btn-ghost"
                        style={{
                            width: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '12px',
                            minWidth: 0,
                            padding: '10px 12px',
                            borderRadius: '16px',
                            border: '1px solid var(--border)',
                            background: accountMenuOpen ? 'var(--background-secondary)' : 'transparent',
                        }}
                    >
                        <div className="avatar avatar-sm" style={{ flexShrink: 0 }}>
                            {user.avatarUrl ? (
                                <img src={user.avatarUrl} alt={user.displayName} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                            ) : (
                                (user.displayName?.charAt(0) || user.handle.charAt(0)).toUpperCase()
                            )}
                        </div>
                        <div style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
                            <div style={{ fontWeight: 600, fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.displayName}</div>
                            <div style={{ color: 'var(--foreground-tertiary)', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{formattedHandle}</div>
                        </div>
                        <ChevronDown size={18} style={{
                            transform: accountMenuOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                            transition: 'transform 0.2s ease',
                            flexShrink: 0,
                        }} />
                    </button>
                </div>
            )}

            {/* Identity Unlock Prompt Modal is now handled in LayoutWrapper */}
            {showAuthModal && (
                <AuthScreen
                    modal
                    onClose={() => setShowAuthModal(false)}
                    onSuccess={() => {
                        setShowAuthModal(false);
                        router.refresh();
                    }}
                />
            )}
        </aside>
    );
}
