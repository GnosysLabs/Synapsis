'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { ArrowLeftIcon } from '@/components/Icons';
import { Eye, EyeOff, AlertTriangle, Check } from 'lucide-react';
import { useAuth } from '@/lib/contexts/AuthContext';
import { useRuntimeConfig } from '@/lib/contexts/ConfigContext';
import { shouldExposeAccountNsfwSettings } from '@/lib/nsfw/settings-visibility';

interface NsfwSettings {
    nsfwEnabled: boolean;
    ageVerifiedAt: string | null;
    isNsfw: boolean;
}

export default function ContentSettingsPage() {
    const { isIdentityUnlocked, signUserAction, updateUserProfile } = useAuth();
    const { config, isLoading: configLoading } = useRuntimeConfig();
    const [settings, setSettings] = useState<NsfwSettings | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [showAgeModal, setShowAgeModal] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const localNodeIsNsfw = config?.isNsfw === true;
    const sensitiveViewingActive = Boolean(settings?.nsfwEnabled && settings.ageVerifiedAt);

    useEffect(() => {
        fetchSettings();
    }, []);

    const fetchSettings = async () => {
        try {
            const res = await fetch('/api/settings/nsfw');
            if (res.ok) {
                const data = await res.json();
                setSettings(data);
            }
        } catch {
            setError('Failed to load settings');
        } finally {
            setLoading(false);
        }
    };

    const handleToggleNsfw = async () => {
        if (!settings) return;

        if (!isIdentityUnlocked) {
            setError('Your session expired. Please sign in again.');
            window.location.assign('/login');
            return;
        }

        // If enabling and not verified, show age modal
        if (!settings.ageVerifiedAt) {
            setShowAgeModal(true);
            return;
        }

        // Otherwise just toggle
        setSaving(true);
        setError(null);
        try {
            const signedPayload = await signUserAction('update_nsfw_settings', {
                nsfwEnabled: !settings.nsfwEnabled,
            });
            const res = await fetch('/api/settings/nsfw', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(signedPayload),
            });

            if (res.ok) {
                const data = await res.json();
                setSettings(prev => prev ? { ...prev, nsfwEnabled: data.nsfwEnabled } : null);
                updateUserProfile({ nsfwEnabled: data.nsfwEnabled });
                setSuccess(data.nsfwEnabled ? 'NSFW content enabled' : 'NSFW content disabled');
                setTimeout(() => setSuccess(null), 3000);
            } else {
                const data = await res.json();
                setError(data.error || 'Failed to update');
            }
        } catch (error) {
            setError(error instanceof Error ? error.message : 'Failed to update settings');
        } finally {
            setSaving(false);
        }
    };

    const handleAgeConfirm = async () => {
        if (!isIdentityUnlocked) {
            setShowAgeModal(false);
            setError('Your session expired. Please sign in again.');
            window.location.assign('/login');
            return;
        }

        setSaving(true);
        setError(null);
        try {
            const signedPayload = await signUserAction('update_nsfw_settings', {
                nsfwEnabled: true,
                confirmAge: true,
            });
            const res = await fetch('/api/settings/nsfw', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(signedPayload),
            });

            if (res.ok) {
                const data = await res.json();
                setSettings(prev => prev ? {
                    ...prev,
                    nsfwEnabled: true,
                    ageVerifiedAt: data.ageVerifiedAt,
                } : null);
                updateUserProfile({ nsfwEnabled: true, ageVerifiedAt: data.ageVerifiedAt });
                setShowAgeModal(false);
                setSuccess('NSFW content enabled');
                setTimeout(() => setSuccess(null), 3000);
            } else {
                const data = await res.json();
                setError(data.error || 'Failed to verify');
            }
        } catch (error) {
            setError(error instanceof Error ? error.message : 'Failed to verify age');
        } finally {
            setSaving(false);
        }
    };

    const handleToggleAccountNsfw = async () => {
        if (!settings) return;

        if (!isIdentityUnlocked) {
            setError('Your session expired. Please sign in again.');
            window.location.assign('/login');
            return;
        }

        setSaving(true);
        setError(null);
        try {
            const signedPayload = await signUserAction('update_account_nsfw', {
                isNsfw: !settings.isNsfw,
            });
            const res = await fetch('/api/settings/account-nsfw', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(signedPayload),
            });

            if (res.ok) {
                const data = await res.json();
                setSettings(prev => prev ? { ...prev, isNsfw: data.isNsfw } : null);
                updateUserProfile({ isNsfw: data.isNsfw });
                setSuccess(data.isNsfw ? 'Account marked as NSFW' : 'Account unmarked as NSFW');
                setTimeout(() => setSuccess(null), 3000);
            } else {
                const data = await res.json();
                setError(data.error || 'Failed to update');
            }
        } catch (error) {
            setError(error instanceof Error ? error.message : 'Failed to update settings');
        } finally {
            setSaving(false);
        }
    };

    if (loading || configLoading) {
        return (
            <div style={{ maxWidth: '600px', margin: '0 auto', padding: '24px 16px 64px' }}>
                <div style={{ textAlign: 'center', padding: '48px', color: 'var(--foreground-tertiary)' }}>
                    Loading...
                </div>
            </div>
        );
    }

    if (!shouldExposeAccountNsfwSettings(config?.isNsfw ?? false)
        && settings?.ageVerifiedAt) {
        return (
            <div style={{ maxWidth: '600px', margin: '0 auto', padding: '24px 16px 64px' }}>
                <header style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '16px',
                    marginBottom: '32px',
                }}>
                    <Link href="/settings" style={{ color: 'var(--foreground)' }}>
                        <ArrowLeftIcon />
                    </Link>
                    <div>
                        <h1 style={{ fontSize: '24px', fontWeight: 700 }}>Content Settings</h1>
                        <p style={{ color: 'var(--foreground-tertiary)', fontSize: '14px' }}>
                            Content visibility is managed by this node
                        </p>
                    </div>
                </header>

                <div className="card" style={{ padding: '20px' }}>
                    <div style={{ fontWeight: 600, marginBottom: '8px' }}>
                        Sensitive content enabled
                    </div>
                    <div style={{ color: 'var(--foreground-secondary)', fontSize: '14px', lineHeight: 1.6 }}>
                        This node is permanently designated adult-only. Your age confirmation is on file, so sensitive content is enabled while you are signed in.
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div style={{ maxWidth: '600px', margin: '0 auto', padding: '24px 16px 64px' }}>
            <header style={{
                display: 'flex',
                alignItems: 'center',
                gap: '16px',
                marginBottom: '32px',
            }}>
                <Link href="/settings" style={{ color: 'var(--foreground)' }}>
                    <ArrowLeftIcon />
                </Link>
                <div>
                    <h1 style={{ fontSize: '24px', fontWeight: 700 }}>Content Settings</h1>
                    <p style={{ color: 'var(--foreground-tertiary)', fontSize: '14px' }}>
                        NSFW and content visibility preferences
                    </p>
                </div>
            </header>

            {error && (
                <div style={{
                    padding: '12px 16px',
                    background: 'var(--error-muted)',
                    color: 'var(--error)',
                    borderRadius: 'var(--radius-md)',
                    marginBottom: '16px',
                    fontSize: '14px',
                }}>
                    {error}
                </div>
            )}

            {success && (
                <div style={{
                    padding: '12px 16px',
                    background: 'var(--success-muted)',
                    color: 'var(--success)',
                    borderRadius: 'var(--radius-md)',
                    marginBottom: '16px',
                    fontSize: '14px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                }}>
                    <Check size={16} />
                    {success}
                </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {/* View NSFW Content */}
                <div className="card" style={{ padding: '20px' }}>
                    <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                        gap: '16px',
                    }}>
                        <div style={{ flex: 1 }}>
                            <div style={{
                                fontWeight: 600,
                                marginBottom: '8px',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                            }}>
                                {sensitiveViewingActive ? <Eye size={18} /> : <EyeOff size={18} />}
                                Show NSFW Content
                            </div>
                            <div style={{ color: 'var(--foreground-secondary)', fontSize: '14px' }}>
                                {localNodeIsNsfw && !settings?.ageVerifiedAt
                                    ? 'This node is adult-only. Confirm that you are 18 or older before sensitive content can be shown.'
                                    : sensitiveViewingActive
                                    ? 'You can see posts marked as sensitive or from NSFW accounts/nodes.'
                                    : settings?.nsfwEnabled && !settings.ageVerifiedAt
                                        ? 'Age confirmation is required before sensitive content can be shown.'
                                        : 'NSFW content is hidden from your feeds and search results.'}
                            </div>
                            {settings?.ageVerifiedAt && (
                                <div style={{
                                    marginTop: '8px',
                                    fontSize: '12px',
                                    color: 'var(--foreground-tertiary)',
                                }}>
                                    Age verified on {new Date(settings.ageVerifiedAt).toLocaleDateString()}
                                </div>
                            )}
                        </div>
                        <button
                            onClick={handleToggleNsfw}
                            disabled={saving}
                            className={`btn btn-sm ${sensitiveViewingActive ? 'btn-ghost' : 'btn-primary'}`}
                        >
                            {localNodeIsNsfw && !settings?.ageVerifiedAt
                                ? 'Verify age'
                                : sensitiveViewingActive
                                    ? 'Disable'
                                    : settings?.nsfwEnabled ? 'Verify age' : 'Enable'}
                        </button>
                    </div>
                </div>

                {/* Mark Account as NSFW - only show if NSFW viewing is enabled */}
                {sensitiveViewingActive && (
                    <div className="card" style={{ padding: '20px' }}>
                        <div style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'flex-start',
                            gap: '16px',
                        }}>
                            <div style={{ flex: 1 }}>
                                <div style={{
                                    fontWeight: 600,
                                    marginBottom: '8px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '8px',
                                }}>
                                    <AlertTriangle size={18} />
                                    Mark My Account as NSFW
                                </div>
                                <div style={{ color: 'var(--foreground-secondary)', fontSize: '14px' }}>
                                    {settings?.isNsfw
                                        ? 'Your account is marked as NSFW. All your posts will be hidden from users who haven\'t enabled NSFW content.'
                                        : 'Enable this if you regularly post adult or sensitive content. Your posts will only be visible to users who have enabled NSFW viewing.'}
                                </div>
                            </div>
                            <button
                                onClick={handleToggleAccountNsfw}
                                disabled={saving}
                                style={{
                                    padding: '8px 16px',
                                    borderRadius: 'var(--radius-md)',
                                    border: settings?.isNsfw ? 'none' : '1px solid var(--border)',
                                    background: settings?.isNsfw ? 'var(--error)' : 'var(--background-secondary)',
                                    color: settings?.isNsfw ? 'white' : 'var(--foreground)',
                                    fontWeight: 500,
                                    cursor: saving ? 'not-allowed' : 'pointer',
                                    opacity: saving ? 0.7 : 1,
                                }}
                            >
                                {settings?.isNsfw ? 'Remove' : 'Mark NSFW'}
                            </button>
                        </div>
                    </div>
                )}

                {/* Info box */}
                <div style={{
                    padding: '16px',
                    background: 'var(--background-secondary)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border)',
                }}>
                    <div style={{
                        fontWeight: 600,
                        marginBottom: '8px',
                        fontSize: '14px',
                    }}>
                        How NSFW filtering works
                    </div>
                    <ul style={{
                        margin: 0,
                        paddingLeft: '20px',
                        color: 'var(--foreground-secondary)',
                        fontSize: '13px',
                        lineHeight: 1.6,
                    }}>
                        <li>Content is marked NSFW at three levels: post, account, or node</li>
                        <li>If any level is NSFW, the content is hidden from non-verified users</li>
                        <li>You can mark individual posts as NSFW when composing</li>
                        <li>NSFW content still syncs across the swarm, but is filtered at display time</li>
                    </ul>
                </div>
            </div>

            {/* Age Verification Modal */}
            {showAgeModal && (
                <div style={{
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(0, 0, 0, 0.8)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 1000,
                    padding: '16px',
                }}>
                    <div className="card" style={{
                        maxWidth: '400px',
                        width: '100%',
                        padding: '24px',
                    }}>
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '12px',
                            marginBottom: '16px',
                        }}>
                            <AlertTriangle size={24} color="var(--warning)" />
                            <h2 style={{ fontSize: '18px', fontWeight: 600 }}>Age Verification</h2>
                        </div>
                        <p style={{
                            color: 'var(--foreground-secondary)',
                            fontSize: '14px',
                            marginBottom: '24px',
                            lineHeight: 1.6,
                        }}>
                            NSFW content may include adult themes, nudity, or other sensitive material.
                            By enabling this setting, you confirm that you are at least 18 years old.
                        </p>
                        <div style={{
                            display: 'flex',
                            gap: '12px',
                            justifyContent: 'flex-end',
                        }}>
                            <button
                                onClick={() => setShowAgeModal(false)}
                                style={{
                                    padding: '10px 20px',
                                    borderRadius: 'var(--radius-md)',
                                    border: '1px solid var(--border)',
                                    background: 'transparent',
                                    color: 'var(--foreground)',
                                    fontWeight: 500,
                                    cursor: 'pointer',
                                }}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleAgeConfirm}
                                disabled={saving}
                                className="btn btn-primary"
                            >
                                {saving ? 'Confirming...' : 'I am 18 or older'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
