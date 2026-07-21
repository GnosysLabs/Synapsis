'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Box, ExternalLink, Loader2 } from 'lucide-react';
import { ArrowLeftIcon } from '@/components/Icons';
import { StorageConfigurationPrompt } from '@/components/StorageConfigurationPrompt';
import { getStoragePageState } from './storage-page-state';
import { useAppDialog } from '@/lib/contexts/DialogContext';

interface StorageStatus {
    provider: 'stuffbox' | null;
    stuffboxAvailable: boolean;
    stuffboxBaseUrl: string | null;
}

export default function StorageSettingsPage() {
    const { showConfirm } = useAppDialog();
    const [status, setStatus] = useState<StorageStatus | null>(null);
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [isDisconnecting, setIsDisconnecting] = useState(false);

    const loadStatus = useCallback(async (showLoading = false) => {
        if (showLoading) setIsLoading(true);
        try {
            const response = await fetch('/api/storage/configuration', { cache: 'no-store' });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || 'Unable to load storage settings');
            setStatus(data);
            setError('');
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : 'Unable to load storage settings');
        } finally {
            if (showLoading) setIsLoading(false);
        }
    }, []);

    useEffect(() => { void loadStatus(true); }, [loadStatus]);

    const disconnectStuffbox = async () => {
        const confirmed = await showConfirm({
            title: 'Disconnect Stuffbox?',
            message: 'Stuffbox will be disconnected from this Synapsis account. Existing media links will keep working.',
            confirmLabel: 'Disconnect',
            tone: 'danger',
        });
        if (!confirmed) return;
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

    const pageState = getStoragePageState(status, isLoading);

    if (pageState === 'loading') {
        return (
            <main aria-busy="true" aria-label="Loading media storage" style={{ minHeight: '70vh', display: 'grid', placeItems: 'center', padding: '24px' }}>
                <div role="status" style={{ display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--foreground-secondary)' }}>
                    <Loader2 className="animate-spin" size={22} aria-hidden="true" />
                    <span>Loading media storage…</span>
                </div>
            </main>
        );
    }

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

            {status && <div className="card" style={{ padding: '20px', marginBottom: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                    <Box size={22} />
                    <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600 }}>{!status ? 'Loading…' : status.provider === 'stuffbox' ? 'Stuffbox.xyz connected' : 'Stuffbox not connected'}</div>
                    </div>
                </div>
                {status?.provider === 'stuffbox' && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '18px' }}>
                        <a className="btn btn-primary" href="https://stuffbox.xyz" target="_blank" rel="noopener noreferrer">
                            Manage Storage <ExternalLink size={15} />
                        </a>
                        <button className="btn btn-ghost" type="button" onClick={disconnectStuffbox} disabled={isDisconnecting}>
                            {isDisconnecting ? 'Disconnecting…' : 'Disconnect Stuffbox'}
                        </button>
                    </div>
                )}
            </div>}

            {pageState === 'disconnected' && status && (
                <div className="card" style={{ padding: '20px' }}>
                    <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>
                        Connect Stuffbox
                    </h2>
                    <p style={{ color: 'var(--foreground-secondary)', fontSize: '14px', lineHeight: 1.5, marginBottom: '20px' }}>
                        Connect the official Synapsis storage partner to upload portable media and unlock a Stuffbox checkmark across the federation.
                    </p>
                    <StorageConfigurationPrompt
                        open
                        stuffboxAvailable={status.stuffboxAvailable}
                        onConfigured={loadStatus}
                        onCancel={() => {}}
                        variant="inline"
                    />
                </div>
            )}
            {error && <p style={{ color: 'var(--error)', fontSize: '14px', marginTop: '14px' }}>{error}</p>}
        </div>
    );
}
