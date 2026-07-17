'use client';

import Link from 'next/link';

import { Rocket, Shield, Bell, Eye, UserX, HardDrive, Terminal } from 'lucide-react';
import { useRuntimeConfig } from '@/lib/contexts/ConfigContext';
import { shouldExposeAccountNsfwSettings } from '@/lib/nsfw/settings-visibility';

export default function SettingsPage() {
    const { config, isLoading: configLoading } = useRuntimeConfig();
    const showContentSettings = !configLoading
        && shouldExposeAccountNsfwSettings(config?.isNsfw ?? false);

    return (
        <>
            <header style={{
                padding: '16px',
                borderBottom: '1px solid var(--border)',
                position: 'sticky',
                top: 0,
                background: 'var(--background)',
                zIndex: 10,
                backdropFilter: 'blur(12px)',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <h1 style={{ fontSize: '18px', fontWeight: 600 }}>Settings</h1>
                </div>
            </header>

            <div style={{ maxWidth: '600px', margin: '0 auto', padding: '24px 16px 64px' }}>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>


                    <Link href="/settings/storage" className="card" style={{
                        display: 'block',
                        padding: '20px',
                        textDecoration: 'none',
                        color: 'var(--foreground)',
                        transition: 'border-color 0.15s ease',
                    }}>
                        <div style={{ fontWeight: 600, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <HardDrive size={18} />
                            Media Storage
                        </div>
                        <div style={{ color: 'var(--foreground-secondary)', fontSize: '14px' }}>
                            Connect and manage Stuffbox
                        </div>
                    </Link>

                    <Link href="/settings/cli" className="card" style={{
                        display: 'block',
                        padding: '20px',
                        textDecoration: 'none',
                        color: 'var(--foreground)',
                        transition: 'border-color 0.15s ease',
                    }}>
                        <div style={{ fontWeight: 600, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <Terminal size={18} />
                            CLI & Agents
                        </div>
                        <div style={{ color: 'var(--foreground-secondary)', fontSize: '14px' }}>
                            Approve and revoke command-line posting access
                        </div>
                    </Link>


                    {showContentSettings && (
                        <Link href="/settings/content" className="card" style={{
                            display: 'block',
                            padding: '20px',
                            textDecoration: 'none',
                            color: 'var(--foreground)',
                            transition: 'border-color 0.15s ease',
                        }}>
                            <div style={{ fontWeight: 600, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <Eye size={18} />
                                Content Settings
                            </div>
                            <div style={{ color: 'var(--foreground-secondary)', fontSize: '14px' }}>
                                NSFW preferences and content visibility
                            </div>
                        </Link>
                    )}

                    <Link href="/settings/privacy" className="card" style={{
                        display: 'block',
                        padding: '20px',
                        textDecoration: 'none',
                        color: 'var(--foreground)',
                        transition: 'border-color 0.15s ease',
                    }}>
                        <div style={{ fontWeight: 600, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <Shield size={18} />
                            Privacy & Safety
                        </div>
                        <div style={{ color: 'var(--foreground-secondary)', fontSize: '14px' }}>
                            Control who can message you
                        </div>
                    </Link>

                    <Link href="/settings/moderation" className="card" style={{
                        display: 'block',
                        padding: '20px',
                        textDecoration: 'none',
                        color: 'var(--foreground)',
                        transition: 'border-color 0.15s ease',
                    }}>
                        <div style={{ fontWeight: 600, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <UserX size={18} />
                            Moderation
                        </div>
                        <div style={{ color: 'var(--foreground-secondary)', fontSize: '14px' }}>
                            Blocked users and muted nodes
                        </div>
                    </Link>

                    <Link href="/settings/migration" className="card" style={{
                        display: 'block',
                        padding: '20px',
                        textDecoration: 'none',
                        color: 'var(--foreground)',
                        transition: 'border-color 0.15s ease',
                    }}>
                        <div style={{ fontWeight: 600, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <Rocket size={18} />
                            Export Account
                        </div>
                        <div style={{ color: 'var(--foreground-secondary)', fontSize: '14px' }}>
                            Download a backup of your account and content
                        </div>
                    </Link>

                    <Link href="/settings/security" className="card" style={{
                        display: 'block',
                        padding: '20px',
                        textDecoration: 'none',
                        color: 'var(--foreground)',
                        transition: 'border-color 0.15s ease',
                    }}>
                        <div style={{ fontWeight: 600, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <Shield size={18} />
                            Security
                        </div>
                        <div style={{ color: 'var(--foreground-secondary)', fontSize: '14px' }}>
                            Change password
                        </div>
                    </Link>

                    <Link href="/settings/notifications" className="card" style={{
                        display: 'block',
                        padding: '20px',
                        textDecoration: 'none',
                        color: 'var(--foreground)',
                        transition: 'border-color 0.15s ease',
                    }}>
                        <div style={{ fontWeight: 600, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <Bell size={18} />
                            Notifications
                        </div>
                        <div style={{ color: 'var(--foreground-secondary)', fontSize: '14px' }}>
                            Browser notification preferences
                        </div>
                    </Link>
                </div>
            </div>
        </>
    );
}
