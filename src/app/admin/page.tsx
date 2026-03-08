'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import AutoTextarea from '@/components/AutoTextarea';
import { StorageSessionPrompt } from '@/components/StorageSessionPrompt';
import { useToast } from '@/lib/contexts/ToastContext';
import { useAccentColor } from '@/lib/contexts/AccentColorContext';
import { refreshStorageSession } from '@/lib/storage/client';

export default function AdminPage() {
    const { showToast } = useToast();
    const { refreshAccentColor } = useAccentColor();
    const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
    const [loading, setLoading] = useState(false);
    const [nodeSettings, setNodeSettings] = useState({
        name: '',
        description: '',
        longDescription: '',
        rules: '',
        bannerUrl: '',
        logoUrl: '',
        faviconUrl: '',
        accentColor: '#FFFFFF',
        isNsfw: false,
        turnstileSiteKey: '',
        turnstileSecretKey: '',
    });
    const [savingSettings, setSavingSettings] = useState(false);
    const [isUploadingBanner, setIsUploadingBanner] = useState(false);
    const [bannerUploadError, setBannerUploadError] = useState<string | null>(null);
    const [showBannerSessionPrompt, setShowBannerSessionPrompt] = useState(false);
    const [pendingBannerFile, setPendingBannerFile] = useState<File | null>(null);
    const [bannerPassword, setBannerPassword] = useState('');
    const [bannerPromptError, setBannerPromptError] = useState('');
    const [isRefreshingBannerSession, setIsRefreshingBannerSession] = useState(false);
    const [isUploadingLogo, setIsUploadingLogo] = useState(false);
    const [logoUploadError, setLogoUploadError] = useState<string | null>(null);
    const [isUploadingFavicon, setIsUploadingFavicon] = useState(false);
    const [faviconUploadError, setFaviconUploadError] = useState<string | null>(null);
    const [updateStatus, setUpdateStatus] = useState<{
        current: { version: string; commit: string | null; buildDate: string | null };
        latest: { version: string; commit: string | null; buildDate: string | null } | null;
        updateAvailable: boolean;
        updater: {
            available: boolean;
            status: string;
            message?: string;
            lastStartedAt?: string | null;
            lastFinishedAt?: string | null;
            lastExitCode?: number | null;
            lastError?: string | null;
        };
    } | null>(null);
    const [loadingUpdateStatus, setLoadingUpdateStatus] = useState(false);
    const [triggeringUpdate, setTriggeringUpdate] = useState(false);

    useEffect(() => {
        fetch('/api/admin/me')
            .then((res) => res.json())
            .then((data) => setIsAdmin(!!data.isAdmin))
            .catch(() => setIsAdmin(false));
    }, []);

    const loadNodeSettings = async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/node');
            const data = await res.json();
            setNodeSettings({
                name: data.name || '',
                description: data.description || '',
                longDescription: data.longDescription || '',
                rules: data.rules || '',
                bannerUrl: data.bannerUrl || '',
                logoUrl: data.logoUrl || '',
                faviconUrl: data.faviconUrl || '',
                accentColor: data.accentColor || '#FFFFFF',
                isNsfw: data.isNsfw || false,
                turnstileSiteKey: data.turnstileSiteKey || '',
                turnstileSecretKey: data.turnstileSecretKey || '',
            });
        } catch {
            // error
        } finally {
            setLoading(false);
        }
    };

    const loadUpdateStatus = async () => {
        setLoadingUpdateStatus(true);
        try {
            const res = await fetch('/api/admin/update', { cache: 'no-store' });
            if (!res.ok) {
                throw new Error('Failed to load update status');
            }

            const data = await res.json();
            setUpdateStatus(data);
        } catch {
            setUpdateStatus(null);
        } finally {
            setLoadingUpdateStatus(false);
        }
    };

    useEffect(() => {
        if (isAdmin) {
            loadNodeSettings();
            loadUpdateStatus();
        }
    }, [isAdmin]);

    useEffect(() => {
        if (!isAdmin) {
            return;
        }

        const interval = window.setInterval(() => {
            loadUpdateStatus();
        }, 30000);

        return () => window.clearInterval(interval);
    }, [isAdmin]);

    const handleSaveSettings = async (override?: typeof nodeSettings) => {
        const payload = override ?? nodeSettings;
        setSavingSettings(true);
        try {
            const res = await fetch('/api/admin/node', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (res.ok) {
                showToast('Settings saved!', 'success');
                refreshAccentColor();
            } else {
                showToast('Failed to save settings.', 'error');
            }
        } catch {
            showToast('Failed to save settings.', 'error');
        } finally {
            setSavingSettings(false);
        }
    };

    const uploadBannerFile = async (file: File, allowPrompt = true) => {
        setBannerUploadError(null);
        setIsUploadingBanner(true);

        try {
            const formData = new FormData();
            formData.append('file', file);
            const res = await fetch('/api/media/upload', {
                method: 'POST',
                body: formData,
            });
            const data = await res.json();

            if (!res.ok || !data.url) {
                if (res.status === 401 && allowPrompt) {
                    setPendingBannerFile(file);
                    setBannerPromptError('');
                    setShowBannerSessionPrompt(true);
                    return;
                }

                throw new Error(data.error || 'Upload failed');
            }

            const nextSettings = {
                ...nodeSettings,
                bannerUrl: data.media?.url || data.url,
            };
            setNodeSettings(nextSettings);
            await handleSaveSettings(nextSettings);
            setPendingBannerFile(null);
            setShowBannerSessionPrompt(false);
            setBannerPassword('');
            setBannerPromptError('');
        } catch (error) {
            console.error('Banner upload failed', error);
            setBannerUploadError(error instanceof Error ? error.message : 'Upload failed. Please try again.');
        } finally {
            setIsUploadingBanner(false);
        }
    };

    const handleBannerUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;

        await uploadBannerFile(file);
    };

    const handleBannerSessionSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!pendingBannerFile) {
            setShowBannerSessionPrompt(false);
            return;
        }

        if (!bannerPassword.trim()) {
            setBannerPromptError('Please enter your password');
            return;
        }

        setIsRefreshingBannerSession(true);
        setBannerPromptError('');

        try {
            await refreshStorageSession(bannerPassword.trim());
            await uploadBannerFile(pendingBannerFile, false);
        } catch (error) {
            setBannerPromptError(error instanceof Error ? error.message : 'Failed to confirm password');
        } finally {
            setIsRefreshingBannerSession(false);
        }
    };

    const handleBannerSessionCancel = () => {
        setShowBannerSessionPrompt(false);
        setPendingBannerFile(null);
        setBannerPassword('');
        setBannerPromptError('');
    };

    const handleTriggerUpdate = async () => {
        setTriggeringUpdate(true);
        try {
            const res = await fetch('/api/admin/update', { method: 'POST', keepalive: true });
            const data = await res.json().catch(() => ({}));

            if (!res.ok) {
                throw new Error(data.error || 'Failed to start update');
            }

            showToast(data.message || 'Update started. Synapsis will restart shortly.', 'success');
            await loadUpdateStatus();
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to start update';
            if (message.toLowerCase().includes('fetch') || message.toLowerCase().includes('network')) {
                showToast('Update likely started. The node is restarting, so this page may disconnect briefly.', 'success');
                window.setTimeout(() => {
                    window.location.reload();
                }, 5000);
            } else {
                showToast(message, 'error');
            }
        } finally {
            setTriggeringUpdate(false);
        }
    };

    const handleLogoUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;

        setLogoUploadError(null);
        setIsUploadingLogo(true);

        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('type', 'logo');
            const res = await fetch('/api/admin/node/upload', {
                method: 'POST',
                body: formData,
            });
            const data = await res.json();

            if (!res.ok || !data.url) {
                throw new Error(data.error || 'Upload failed');
            }

            const nextSettings = {
                ...nodeSettings,
                logoUrl: data.url,
            };
            setNodeSettings(nextSettings);
            await handleSaveSettings(nextSettings);
        } catch (error) {
            console.error('Logo upload failed', error);
            setLogoUploadError(error instanceof Error ? error.message : 'Upload failed. Please try again.');
        } finally {
            setIsUploadingLogo(false);
        }
    };

    const handleFaviconUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;

        setFaviconUploadError(null);
        setIsUploadingFavicon(true);

        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('type', 'favicon');
            const res = await fetch('/api/admin/node/upload', {
                method: 'POST',
                body: formData,
            });
            const data = await res.json();

            if (!res.ok || !data.url) {
                throw new Error(data.error || 'Upload failed');
            }

            const nextSettings = {
                ...nodeSettings,
                faviconUrl: data.url,
            };
            setNodeSettings(nextSettings);
            await handleSaveSettings(nextSettings);
        } catch (error) {
            console.error('Favicon upload failed', error);
            setFaviconUploadError(error instanceof Error ? error.message : 'Upload failed. Please try again.');
        } finally {
            setIsUploadingFavicon(false);
        }
    };

    if (isAdmin === null) {
        return (
            <div style={{ padding: '24px' }}>
                <div className="card" style={{ padding: '24px' }}>Checking permissions...</div>
            </div>
        );
    }

    if (!isAdmin) {
        return (
            <div style={{ padding: '24px' }}>
                <div className="card" style={{ padding: '24px' }}>
                    <h1 style={{ marginBottom: '12px' }}>Admin Settings</h1>
                    <p>You do not have access to this page.</p>
                    <Link href="/" className="btn btn-primary" style={{ marginTop: '12px' }}>
                        Back to home
                    </Link>
                </div>
            </div>
        );
    }

    const formatTimestamp = (value?: string | null) => {
        if (!value) return 'Never';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return date.toLocaleString();
    };

    const updateStatusLabel = (() => {
        if (loadingUpdateStatus) return 'Checking...';
        if (!updateStatus) return 'Unavailable';
        if (!updateStatus.updater.available) return updateStatus.updater.message || 'Updater unavailable';
        if (updateStatus.updater.status === 'updating') return updateStatus.updater.message || 'Update in progress';
        if (updateStatus.updater.status === 'error') return updateStatus.updater.message || 'Last update failed';
        if (updateStatus.updateAvailable) return 'Update available';
        return 'Up to date';
    })();

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
                <h1 style={{ fontSize: '18px', fontWeight: 600 }}>Admin Settings</h1>
            </header>

            {loading ? (
                <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>Loading settings...</div>
            ) : (
                <div style={{ display: 'grid', gap: '16px', maxWidth: '600px', padding: '16px' }}>
                            <div>
                                <label style={{ fontSize: '13px', fontWeight: 500, marginBottom: '4px', display: 'block' }}>Node Name</label>
                                <input
                                    className="input"
                                    value={nodeSettings.name}
                                    onChange={e => setNodeSettings({ ...nodeSettings, name: e.target.value })}
                                    placeholder="My Synapsis Node"
                                />
                            </div>

                            <div>
                                <label style={{ fontSize: '13px', fontWeight: 500, marginBottom: '4px', display: 'block' }}>Logo</label>
                                <p style={{ fontSize: '12px', color: 'var(--foreground-tertiary)', marginBottom: '8px' }}>
                                    Replaces the default logo in the sidebar. Max width: 200px.
                                </p>
                                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                                    <label className="btn btn-ghost btn-sm">
                                        {isUploadingLogo ? 'Uploading...' : 'Upload logo'}
                                        <input
                                            type="file"
                                            accept="image/*"
                                            onChange={handleLogoUpload}
                                            disabled={isUploadingLogo}
                                            style={{ display: 'none' }}
                                        />
                                    </label>
                                    {nodeSettings.logoUrl && (
                                        <button
                                            className="btn btn-ghost btn-sm"
                                            onClick={async () => {
                                                const nextSettings = { ...nodeSettings, logoUrl: '' };
                                                setNodeSettings(nextSettings);
                                                await handleSaveSettings(nextSettings);
                                            }}
                                        >
                                            Remove logo
                                        </button>
                                    )}
                                    {logoUploadError && (
                                        <span style={{ fontSize: '12px', color: 'var(--danger)' }}>{logoUploadError}</span>
                                    )}
                                </div>
                                {nodeSettings.logoUrl && (
                                    <div style={{ marginTop: '8px', padding: '12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--background-secondary)' }}>
                                        <img
                                            src={nodeSettings.logoUrl}
                                            alt="Custom logo"
                                            style={{ maxWidth: '200px', maxHeight: '60px', objectFit: 'contain' }}
                                        />
                                    </div>
                                )}
                            </div>

                            <div>
                                <label style={{ fontSize: '13px', fontWeight: 500, marginBottom: '4px', display: 'block' }}>Favicon</label>
                                <p style={{ fontSize: '12px', color: 'var(--foreground-tertiary)', marginBottom: '8px' }}>
                                    The icon shown in browser tabs. Recommended: 32x32 or 64x64 PNG.
                                </p>
                                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                                    <label className="btn btn-ghost btn-sm">
                                        {isUploadingFavicon ? 'Uploading...' : 'Upload favicon'}
                                        <input
                                            type="file"
                                            accept="image/png,image/x-icon,image/svg+xml"
                                            onChange={handleFaviconUpload}
                                            disabled={isUploadingFavicon}
                                            style={{ display: 'none' }}
                                        />
                                    </label>
                                    {nodeSettings.faviconUrl && (
                                        <button
                                            className="btn btn-ghost btn-sm"
                                            onClick={async () => {
                                                const nextSettings = { ...nodeSettings, faviconUrl: '' };
                                                setNodeSettings(nextSettings);
                                                await handleSaveSettings(nextSettings);
                                            }}
                                        >
                                            Remove favicon
                                        </button>
                                    )}
                                    {faviconUploadError && (
                                        <span style={{ fontSize: '12px', color: 'var(--danger)' }}>{faviconUploadError}</span>
                                    )}
                                </div>
                                {nodeSettings.faviconUrl && (
                                    <div style={{ marginTop: '8px', padding: '12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--background-secondary)', display: 'inline-block' }}>
                                        <img
                                            src={nodeSettings.faviconUrl}
                                            alt="Custom favicon"
                                            style={{ width: '32px', height: '32px', objectFit: 'contain' }}
                                        />
                                    </div>
                                )}
                            </div>

                            <div>
                                <label style={{ fontSize: '13px', fontWeight: 500, marginBottom: '4px', display: 'block' }}>Short Description</label>
                                <AutoTextarea
                                    className="input"
                                    value={nodeSettings.description}
                                    onChange={e => setNodeSettings({ ...nodeSettings, description: e.target.value })}
                                    placeholder="A brief tagline for your node."
                                    rows={2}
                                />
                            </div>

                            <div>
                                <label style={{ fontSize: '13px', fontWeight: 500, marginBottom: '4px', display: 'block' }}>Accent Color</label>
                                <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                                    <input
                                        type="color"
                                        value={nodeSettings.accentColor}
                                        onChange={(e) => setNodeSettings({ ...nodeSettings, accentColor: e.target.value })}
                                        style={{ width: '44px', height: '36px', padding: 0, border: '1px solid var(--border)', background: 'transparent', borderRadius: '8px' }}
                                    />
                                    <input
                                        className="input"
                                        value={nodeSettings.accentColor}
                                        onChange={(e) => setNodeSettings({ ...nodeSettings, accentColor: e.target.value })}
                                        placeholder="#FFFFFF"
                                    />
                                </div>
                            </div>

                            <div>
                                <label style={{ fontSize: '13px', fontWeight: 500, marginBottom: '4px', display: 'block' }}>Banner image</label>
                                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                                    <label className="btn btn-ghost btn-sm">
                                        {isUploadingBanner ? 'Uploading...' : 'Upload banner'}
                                        <input
                                            type="file"
                                            accept="image/*"
                                            onChange={handleBannerUpload}
                                            disabled={isUploadingBanner}
                                            style={{ display: 'none' }}
                                        />
                                    </label>
                                    {bannerUploadError && (
                                        <span style={{ fontSize: '12px', color: 'var(--danger)' }}>{bannerUploadError}</span>
                                    )}
                                </div>
                                {nodeSettings.bannerUrl && (
                                    <div style={{ marginTop: '12px' }}>
                                        <img
                                            src={nodeSettings.bannerUrl}
                                            alt="Banner preview"
                                            style={{
                                                width: '100%',
                                                maxWidth: '520px',
                                                maxHeight: '220px',
                                                borderRadius: '12px',
                                                border: '1px solid var(--border)',
                                                objectFit: 'cover',
                                                display: 'block',
                                            }}
                                        />
                                    </div>
                                )}
                            </div>

                            <div>
                                <label style={{ fontSize: '13px', fontWeight: 500, marginBottom: '4px', display: 'block' }}>Long Description (About)</label>
                                <AutoTextarea
                                    className="input"
                                    value={nodeSettings.longDescription}
                                    onChange={e => setNodeSettings({ ...nodeSettings, longDescription: e.target.value })}
                                    placeholder="Detailed information about your node/community."
                                    rows={5}
                                />
                            </div>

                            <div>
                                <label style={{ fontSize: '13px', fontWeight: 500, marginBottom: '4px', display: 'block' }}>Rules</label>
                                <AutoTextarea
                                    className="input"
                                    value={nodeSettings.rules}
                                    onChange={e => setNodeSettings({ ...nodeSettings, rules: e.target.value })}
                                    placeholder="Community rules and guidelines."
                                    rows={5}
                                />
                            </div>

                            <div style={{ 
                                padding: '16px', 
                                background: nodeSettings.isNsfw ? 'rgba(239, 68, 68, 0.1)' : 'var(--background-secondary)', 
                                borderRadius: '8px',
                                border: nodeSettings.isNsfw ? '1px solid var(--error)' : '1px solid var(--border)',
                            }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px' }}>
                                    <div>
                                        <label style={{ fontSize: '13px', fontWeight: 600, marginBottom: '4px', display: 'block' }}>
                                            NSFW Node
                                        </label>
                                        <p style={{ fontSize: '12px', color: 'var(--foreground-secondary)', margin: 0 }}>
                                            {nodeSettings.isNsfw 
                                                ? 'This node is marked as NSFW. All content will be hidden from users who haven\'t enabled NSFW viewing.'
                                                : 'Enable this if your node primarily hosts adult or sensitive content. All posts from this node will be treated as NSFW across the swarm.'}
                                        </p>
                                    </div>
                                    <button
                                        className={`btn btn-sm ${nodeSettings.isNsfw ? 'btn-primary' : 'btn-ghost'}`}
                                        style={{ 
                                            background: nodeSettings.isNsfw ? 'var(--error)' : undefined,
                                            flexShrink: 0,
                                        }}
                                        onClick={() => {
                                            if (!nodeSettings.isNsfw) {
                                                const confirmed = window.confirm(
                                                    'Are you sure you want to mark this node as NSFW?\n\n' +
                                                    'All content from this node will be hidden from users who haven\'t enabled NSFW viewing. ' +
                                                    'This affects the entire swarm.'
                                                );
                                                if (confirmed) {
                                                    setNodeSettings({ ...nodeSettings, isNsfw: true });
                                                }
                                            } else {
                                                setNodeSettings({ ...nodeSettings, isNsfw: false });
                                            }
                                        }}
                                    >
                                        {nodeSettings.isNsfw ? 'Remove NSFW' : 'Mark as NSFW'}
                                    </button>
                                </div>
                            </div>

                            <div style={{ 
                                padding: '16px', 
                                background: 'var(--background-secondary)', 
                                borderRadius: '8px',
                                border: '1px solid var(--border)',
                            }}>
                                <div style={{ marginBottom: '16px' }}>
                                    <label style={{ fontSize: '13px', fontWeight: 600, marginBottom: '4px', display: 'block' }}>
                                        Cloudflare Turnstile (Bot Protection)
                                    </label>
                                    <p style={{ fontSize: '12px', color: 'var(--foreground-secondary)', marginBottom: '12px' }}>
                                        Add Cloudflare Turnstile to protect registration and login from bots. Get your keys from the{' '}
                                        <a href="https://dash.cloudflare.com/?to=/:account/turnstile" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
                                            Cloudflare Dashboard
                                        </a>.
                                    </p>
                                    {nodeSettings.turnstileSiteKey && nodeSettings.turnstileSecretKey && (
                                        <div style={{ 
                                            padding: '8px 12px', 
                                            background: 'rgba(34, 197, 94, 0.1)', 
                                            border: '1px solid rgba(34, 197, 94, 0.3)',
                                            borderRadius: '6px',
                                            fontSize: '12px',
                                            color: 'rgb(34, 197, 94)',
                                            marginBottom: '12px',
                                        }}>
                                            ✓ Turnstile is enabled and will be shown on login/registration
                                        </div>
                                    )}
                                </div>
                                <div style={{ display: 'grid', gap: '12px' }}>
                                    <div>
                                        <label style={{ fontSize: '12px', fontWeight: 500, marginBottom: '4px', display: 'block' }}>
                                            Site Key
                                        </label>
                                        <input
                                            className="input"
                                            type="text"
                                            value={nodeSettings.turnstileSiteKey}
                                            onChange={e => setNodeSettings({ ...nodeSettings, turnstileSiteKey: e.target.value })}
                                            placeholder="0x4AAAAAAA..."
                                            style={{ fontFamily: 'monospace', fontSize: '13px' }}
                                        />
                                        <p style={{ fontSize: '11px', color: 'var(--foreground-tertiary)', marginTop: '4px' }}>
                                            Public key shown to users
                                        </p>
                                    </div>
                                    <div>
                                        <label style={{ fontSize: '12px', fontWeight: 500, marginBottom: '4px', display: 'block' }}>
                                            Secret Key
                                        </label>
                                        <input
                                            className="input"
                                            type="password"
                                            value={nodeSettings.turnstileSecretKey}
                                            onChange={e => setNodeSettings({ ...nodeSettings, turnstileSecretKey: e.target.value })}
                                            placeholder={nodeSettings.turnstileSecretKey ? '••••••••••••••••' : '0x4AAAAAAA...'}
                                            style={{ fontFamily: 'monospace', fontSize: '13px' }}
                                        />
                                        <p style={{ fontSize: '11px', color: 'var(--foreground-tertiary)', marginTop: '4px' }}>
                                            {nodeSettings.turnstileSecretKey ? 'Secret key is configured (hidden for security)' : 'Secret key for server-side verification'}
                                        </p>
                                    </div>
                                </div>
                            </div>

                            <div style={{ paddingTop: '8px' }}>
                                <button className="btn btn-primary" onClick={() => handleSaveSettings()} disabled={savingSettings}>
                                    {savingSettings ? 'Saving...' : 'Save Settings'}
                                </button>
                            </div>

                            <div style={{
                                padding: '16px',
                                background: 'var(--background-secondary)',
                                borderRadius: '8px',
                                border: '1px solid var(--border)',
                            }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' }}>
                                    <div>
                                        <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '6px' }}>System Update</h2>
                                        <p style={{ fontSize: '13px', color: 'var(--foreground-secondary)', margin: 0 }}>
                                            Keep this node on the latest published Synapsis build.
                                        </p>
                                    </div>
                                    <button
                                        className="btn btn-primary"
                                        onClick={handleTriggerUpdate}
                                        disabled={
                                            triggeringUpdate ||
                                            loadingUpdateStatus ||
                                            updateStatus?.updater.available === false ||
                                            updateStatus?.updater.status === 'updating' ||
                                            !updateStatus?.updateAvailable
                                        }
                                    >
                                        {triggeringUpdate || updateStatus?.updater.status === 'updating' ? 'Updating...' : 'Update Now'}
                                    </button>
                                </div>

                                <div style={{ display: 'grid', gap: '8px', marginTop: '16px', fontSize: '13px' }}>
                                    <div>
                                        <strong>Current build:</strong>{' '}
                                        {updateStatus?.current?.version || 'Unknown'}
                                    </div>
                                    <div>
                                        <strong>Latest build:</strong>{' '}
                                        {updateStatus?.latest?.version || 'Unavailable'}
                                    </div>
                                    <div>
                                        <strong>Status:</strong>{' '}
                                        {updateStatusLabel}
                                    </div>
                                    {updateStatus?.updater.lastStartedAt && (
                                        <div>
                                            <strong>Last started:</strong>{' '}
                                            {formatTimestamp(updateStatus.updater.lastStartedAt)}
                                        </div>
                                    )}
                                    {updateStatus?.updater.lastFinishedAt && (
                                        <div>
                                            <strong>Last finished:</strong>{' '}
                                            {formatTimestamp(updateStatus.updater.lastFinishedAt)}
                                        </div>
                                    )}
                                    {typeof updateStatus?.updater.lastExitCode === 'number' && (
                                        <div>
                                            <strong>Last exit code:</strong>{' '}
                                            {updateStatus.updater.lastExitCode}
                                        </div>
                                    )}
                                    {updateStatus?.updater.lastError && (
                                        <div style={{ color: 'var(--danger)' }}>
                                            <strong>Last error:</strong>{' '}
                                            {updateStatus.updater.lastError}
                                        </div>
                                    )}
                                </div>

                                {!updateStatus?.updater.available && (
                                    <div style={{
                                        marginTop: '16px',
                                        padding: '12px',
                                        borderRadius: '8px',
                                        border: '1px solid var(--border)',
                                        background: 'var(--background)',
                                        fontSize: '12px',
                                        color: 'var(--foreground-secondary)',
                                    }}>
                                        One-click updates are unavailable on this host. Use:
                                        <div style={{ marginTop: '8px', fontFamily: 'monospace', color: 'var(--foreground)' }}>
                                            curl -fsSL https://synapsis.social/update.sh | bash
                                        </div>
                                    </div>
                                )}
                            </div>
                </div>
            )}

            <StorageSessionPrompt
                open={showBannerSessionPrompt}
                isSubmitting={isRefreshingBannerSession}
                password={bannerPassword}
                error={bannerPromptError}
                description="Please confirm your password to continue uploading this banner to your storage."
                onPasswordChange={(nextPassword) => {
                    setBannerPassword(nextPassword);
                    setBannerPromptError('');
                }}
                onSubmit={handleBannerSessionSubmit}
                onCancel={handleBannerSessionCancel}
            />
        </>
    );
}
