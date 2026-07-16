'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeftIcon } from '@/components/Icons';
import { MessageSquare, Check } from 'lucide-react';
import { useAuth } from '@/lib/contexts/AuthContext';

export default function PrivacySettingsPage() {
    const router = useRouter();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [dmPrivacy, setDmPrivacy] = useState<'everyone' | 'following' | 'none'>('everyone');
    const [status, setStatus] = useState<{ type: 'success' | 'error', message: string } | null>(null);

    const { isIdentityUnlocked, signUserAction } = useAuth();

    useEffect(() => {
        fetch('/api/auth/me')
            .then(res => res.json())
            .then(data => {
                if (data.user) {
                    setDmPrivacy(data.user.dmPrivacy || 'everyone');
                }
                setLoading(false);
            })
            .catch(() => setLoading(false));
    }, []);

    const handleSave = async (newValue: 'everyone' | 'following' | 'none') => {
        if (!isIdentityUnlocked) {
            setStatus({ type: 'error', message: 'Session expired. Please log in again.' });
            return;
        }

        setDmPrivacy(newValue);
        setSaving(true);
        setStatus(null);

        try {
            const signedPayload = await signUserAction('update_profile', { dmPrivacy: newValue });

            const res = await fetch('/api/auth/me', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(signedPayload),
            });

            if (res.ok) {
                setStatus({ type: 'success', message: 'Settings saved successfully' });
                setTimeout(() => setStatus(null), 3000);
            } else {
                const data = await res.json();
                setStatus({ type: 'error', message: data.error || 'Failed to save settings' });
            }
        } catch {
            setStatus({ type: 'error', message: 'An error occurred' });
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>
                Loading privacy settings...
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
                <button
                    onClick={() => router.back()}
                    style={{
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        color: 'var(--foreground)',
                        display: 'flex',
                        alignItems: 'center'
                    }}
                >
                    <ArrowLeftIcon />
                </button>
                <div>
                    <h1 style={{ fontSize: '24px', fontWeight: 700 }}>Privacy & Safety</h1>
                    <p style={{ color: 'var(--foreground-tertiary)', fontSize: '14px' }}>
                        Message and social privacy preferences
                    </p>
                </div>
            </header>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ marginBottom: '16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                        <MessageSquare size={20} style={{ color: 'var(--accent)' }} />
                        <h2 style={{ fontSize: '18px', fontWeight: 600, margin: 0 }}>Direct Messages</h2>
                    </div>

                    <p style={{ color: 'var(--foreground-secondary)', fontSize: '14px', marginBottom: '20px' }}>
                        Control who can send you direct messages on Synapsis.
                    </p>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <button
                            onClick={() => handleSave('everyone')}
                            disabled={saving}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                padding: '16px',
                                background: dmPrivacy === 'everyone' ? 'var(--accent-muted)' : 'var(--background-secondary)',
                                border: '1px solid',
                                borderColor: dmPrivacy === 'everyone' ? 'var(--accent)' : 'var(--border)',
                                borderRadius: '12px',
                                cursor: 'pointer',
                                textAlign: 'left',
                                transition: 'all 0.15s ease',
                                width: '100%',
                                color: 'var(--foreground)',
                            }}
                        >
                            <div>
                                <div style={{ fontWeight: 600, marginBottom: '2px' }}>Everyone</div>
                                <div style={{ fontSize: '13px', color: 'var(--foreground-tertiary)' }}>Anyone can message you</div>
                            </div>
                            {dmPrivacy === 'everyone' && <Check size={18} style={{ color: 'var(--accent)' }} />}
                        </button>

                        <button
                            onClick={() => handleSave('following')}
                            disabled={saving}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                padding: '16px',
                                background: dmPrivacy === 'following' ? 'var(--accent-muted)' : 'var(--background-secondary)',
                                border: '1px solid',
                                borderColor: dmPrivacy === 'following' ? 'var(--accent)' : 'var(--border)',
                                borderRadius: '12px',
                                cursor: 'pointer',
                                textAlign: 'left',
                                transition: 'all 0.15s ease',
                                width: '100%',
                                color: 'var(--foreground)',
                            }}
                        >
                            <div>
                                <div style={{ fontWeight: 600, marginBottom: '2px' }}>Following Only</div>
                                <div style={{ fontSize: '13px', color: 'var(--foreground-tertiary)' }}>Only accounts you follow can message you</div>
                            </div>
                            {dmPrivacy === 'following' && <Check size={18} style={{ color: 'var(--accent)' }} />}
                        </button>

                        <button
                            onClick={() => handleSave('none')}
                            disabled={saving}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                padding: '16px',
                                background: dmPrivacy === 'none' ? 'var(--accent-muted)' : 'var(--background-secondary)',
                                border: '1px solid',
                                borderColor: dmPrivacy === 'none' ? 'var(--accent)' : 'var(--border)',
                                borderRadius: '12px',
                                cursor: 'pointer',
                                textAlign: 'left',
                                transition: 'all 0.15s ease',
                                width: '100%',
                                color: 'var(--foreground)',
                            }}
                        >
                            <div>
                                <div style={{ fontWeight: 600, marginBottom: '2px' }}>None</div>
                                <div style={{ fontSize: '13px', color: 'var(--foreground-tertiary)' }}>No one can send you new messages</div>
                            </div>
                            {dmPrivacy === 'none' && <Check size={18} style={{ color: 'var(--accent)' }} />}
                        </button>
                    </div>
                </div>

                {status && (
                    <div style={{
                        padding: '12px',
                        borderRadius: '8px',
                        background: status.type === 'success' ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                        color: status.type === 'success' ? '#22c55e' : '#ef4444',
                        fontSize: '14px',
                        textAlign: 'center',
                        marginTop: '16px',
                    }}>
                        {status.message}
                    </div>
                )}
            </div>
        </div>
    );
}
