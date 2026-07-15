'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Box, Cloud, HardDrive } from 'lucide-react';
import { ArrowLeftIcon } from '@/components/Icons';
import { StorageConfigurationPrompt } from '@/components/StorageConfigurationPrompt';

interface StorageStatus {
    provider: 'stuffbox' | 's3' | null;
    stuffboxAvailable: boolean;
    stuffboxBaseUrl: string | null;
    s3Provider: string | null;
}

export default function StorageSettingsPage() {
    const [status, setStatus] = useState<StorageStatus | null>(null);
    const [error, setError] = useState('');
    const [isDisconnecting, setIsDisconnecting] = useState(false);

    const loadStatus = useCallback(async () => {
        try {
            const response = await fetch('/api/storage/configuration', { cache: 'no-store' });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || 'Unable to load storage settings');
            setStatus(data);
            setError('');
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : 'Unable to load storage settings');
        }
    }, []);

    useEffect(() => { void loadStatus(); }, [loadStatus]);

    const disconnectStuffbox = async () => {
        if (!window.confirm('Disconnect Stuffbox from this Synapsis account? Existing media links will keep working.')) return;
        setIsDisconnecting(true);
        setError('');
        try {
            const response = await fetch('/api/storage/stuffbox/disconnect', { method: 'POST' });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || 'Unable to disconnect Stuffbox');
            await loadStatus();
        } catch (disconnectError) {
            setError(disconnectError instanceof Error ? disconnectError.message : 'Unable to disconnect Stuffbox');
        } finally {
            setIsDisconnecting(false);
        }
    };

    return (
        <div style={{ maxWidth: '600px', margin: '0 auto', padding: '24px 16px 64px' }}>
            <header style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '32px' }}>
                <Link href="/settings" style={{ color: 'var(--foreground)' }} aria-label="Back to settings">
                    <ArrowLeftIcon />
                </Link>
                <div>
                    <h1 style={{ fontSize: '24px', fontWeight: 700 }}>Media Storage</h1>
                    <p style={{ color: 'var(--foreground-tertiary)', fontSize: '14px' }}>
                        Manage where your account stores uploaded media
                    </p>
                </div>
            </header>

            <p style={{ color: 'var(--foreground-secondary)', lineHeight: 1.5, marginBottom: '20px' }}>
                Storage belongs to your account rather than this node. That keeps your media available if you move your account elsewhere.
            </p>

            <div className="card" style={{ padding: '20px', marginBottom: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                    {status?.provider === 'stuffbox' ? <Box size={22} /> : status?.provider === 's3' ? <Cloud size={22} /> : <HardDrive size={22} />}
                    <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600 }}>{!status ? 'Loading…' : status.provider === 'stuffbox' ? 'Stuffbox connected' : status.provider === 's3' ? 'S3 storage connected' : 'No media storage connected'}</div>
                        {status?.stuffboxBaseUrl && <div style={{ color: 'var(--foreground-secondary)', fontSize: '13px', marginTop: '5px', wordBreak: 'break-all' }}>{status.stuffboxBaseUrl}</div>}
                        {status?.s3Provider && status.provider === 's3' && <div style={{ color: 'var(--foreground-secondary)', fontSize: '13px', marginTop: '5px' }}>Provider: {status.s3Provider}</div>}
                    </div>
                </div>
                {status?.provider === 'stuffbox' && (
                    <button className="btn btn-ghost" type="button" onClick={disconnectStuffbox} disabled={isDisconnecting} style={{ marginTop: '18px' }}>
                        {isDisconnecting ? 'Disconnecting…' : 'Disconnect Stuffbox'}
                    </button>
                )}
            </div>

            <div className="card" style={{ padding: '20px' }}>
                <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>
                    {status?.provider ? 'Change storage' : 'Connect media storage'}
                </h2>
                <p style={{ color: 'var(--foreground-secondary)', fontSize: '14px', lineHeight: 1.5, marginBottom: '20px' }}>
                    Choose Stuffbox for the simplest setup, or connect an S3-compatible bucket you already own.
                </p>
                <StorageConfigurationPrompt open onConfigured={loadStatus} onCancel={() => {}} variant="inline" />
            </div>
            {error && <p style={{ color: 'var(--error)', fontSize: '14px', marginTop: '14px' }}>{error}</p>}
        </div>
    );
}
