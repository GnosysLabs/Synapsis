'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Box, Cloud, HardDrive } from 'lucide-react';
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
    const [showConnect, setShowConnect] = useState(false);
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

    return <>
        <header style={{ padding: '16px', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--background)', zIndex: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <Link href="/settings" className="btn btn-ghost btn-sm" aria-label="Back to settings"><ArrowLeft size={18} /></Link>
                <h1 style={{ fontSize: '18px', fontWeight: 600 }}>Media Storage</h1>
            </div>
        </header>
        <main style={{ maxWidth: '600px', margin: '0 auto', padding: '24px 16px 64px' }}>
            <p style={{ color: 'var(--foreground-secondary)', lineHeight: 1.5, marginBottom: '20px' }}>
                Storage belongs to your account rather than this node. That keeps your media available if you move your account elsewhere.
            </p>

            <div className="card" style={{ padding: '20px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                    {status?.provider === 'stuffbox' ? <Box size={22} /> : status?.provider === 's3' ? <Cloud size={22} /> : <HardDrive size={22} />}
                    <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600 }}>{!status ? 'Loading…' : status.provider === 'stuffbox' ? 'Stuffbox connected' : status.provider === 's3' ? 'S3 storage connected' : 'No media storage connected'}</div>
                        {status?.stuffboxBaseUrl && <div style={{ color: 'var(--foreground-secondary)', fontSize: '13px', marginTop: '5px', wordBreak: 'break-all' }}>{status.stuffboxBaseUrl}</div>}
                        {status?.s3Provider && status.provider === 's3' && <div style={{ color: 'var(--foreground-secondary)', fontSize: '13px', marginTop: '5px' }}>Provider: {status.s3Provider}</div>}
                    </div>
                </div>
                <div style={{ display: 'flex', gap: '10px', marginTop: '18px', flexWrap: 'wrap' }}>
                    <button className="btn btn-primary" type="button" onClick={() => setShowConnect(true)} disabled={!status}>{status?.provider ? 'Change storage' : 'Connect storage'}</button>
                    {status?.provider === 'stuffbox' && <button className="btn btn-ghost" type="button" onClick={disconnectStuffbox} disabled={isDisconnecting}>{isDisconnecting ? 'Disconnecting…' : 'Disconnect Stuffbox'}</button>}
                </div>
            </div>
            {error && <p style={{ color: 'var(--error)', fontSize: '14px', marginTop: '14px' }}>{error}</p>}
        </main>
        <StorageConfigurationPrompt open={showConnect} onConfigured={async () => { setShowConnect(false); await loadStatus(); }} onCancel={() => setShowConnect(false)} />
    </>;
}
