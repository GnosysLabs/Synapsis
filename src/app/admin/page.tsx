'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import AutoTextarea from '@/components/AutoTextarea';
import { StorageConfigurationPrompt } from '@/components/StorageConfigurationPrompt';
import { useToast } from '@/lib/contexts/ToastContext';
import { useAccentColor } from '@/lib/contexts/AccentColorContext';
import { getStorageProvider, MediaUploadError, uploadMediaFile } from '@/lib/stuffbox/browser-upload';
import { stripPhotoVideoMetadata } from '@/lib/media/browser-strip-metadata';
import { hasUnsavedChanges } from '@/lib/forms/dirty-state';
import { useRuntimeConfig } from '@/lib/contexts/ConfigContext';
import { useAppDialog } from '@/lib/contexts/DialogContext';
import { matchesNodeDomainConfirmation } from '@/lib/node/nsfw-classification';

export default function AdminPage() {
    const { showToast } = useToast();
    const { showPrompt } = useAppDialog();
    const { refreshAccentColor } = useAccentColor();
    const { setNodeNsfw } = useRuntimeConfig();
    const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
    const [nodeDomain, setNodeDomain] = useState('');
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
    const savedNodeSettingsRef = useRef<typeof nodeSettings | null>(null);
    const nodeSettingsChanged = hasUnsavedChanges(nodeSettings, savedNodeSettingsRef.current);
    const [savingSettings, setSavingSettings] = useState(false);
    const [isUploadingBanner, setIsUploadingBanner] = useState(false);
    const [bannerUploadError, setBannerUploadError] = useState<string | null>(null);
    const [showBannerStorageConfiguration, setShowBannerStorageConfiguration] = useState(false);
    const [pendingBannerFile, setPendingBannerFile] = useState<File | null>(null);
    const [isUploadingLogo, setIsUploadingLogo] = useState(false);
    const [logoUploadError, setLogoUploadError] = useState<string | null>(null);
    const [isUploadingFavicon, setIsUploadingFavicon] = useState(false);
    const [faviconUploadError, setFaviconUploadError] = useState<string | null>(null);
    const bannerInputRef = useRef<HTMLInputElement>(null);
    const bannerStorageCheckInFlightRef = useRef(false);
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
            const loadedSettings = {
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
            };
            setNodeSettings(loadedSettings);
            setNodeDomain(data.domain || window.location.host);
            savedNodeSettingsRef.current = loadedSettings;
        } catch {
            // error
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (isAdmin) {
            loadNodeSettings();
        }
    }, [isAdmin]);

    const handleSaveSettings = async (
        override?: typeof nodeSettings,
        nsfwConfirmationDomain?: string,
    ): Promise<boolean> => {
        const payload = override ?? nodeSettings;
        setSavingSettings(true);
        try {
            const res = await fetch('/api/admin/node', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payload, nsfwConfirmationDomain }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                savedNodeSettingsRef.current = payload;
                if (data.node) {
                    // Keep the global local-node classification and the sidebar's
                    // node payload in the same React batch. Otherwise profile
                    // media briefly sees "remote NSFW node on a safe local node"
                    // and applies a blur until the next full config refresh.
                    setNodeNsfw(data.node.isNsfw === true);
                    window.dispatchEvent(new CustomEvent('synapsis:node-updated', { detail: data.node }));
                }
                showToast('Settings saved!', 'success');
                refreshAccentColor();
                return true;
            } else {
                showToast(data.error || 'Failed to save settings.', 'error');
                return false;
            }
        } catch {
            showToast('Failed to save settings.', 'error');
            return false;
        } finally {
            setSavingSettings(false);
        }
    };

    const handleMakeNodeAdultOnly = async () => {
        if (nodeSettings.isNsfw || savingSettings || !nodeDomain) return;

        const confirmation = await showPrompt({
            title: 'Permanently make this node adult-only?',
            message: `This cannot be undone. Every post from this node will be treated as NSFW across the swarm. Type ${nodeDomain} to confirm.`,
            inputLabel: `Type ${nodeDomain} exactly`,
            placeholder: nodeDomain,
            confirmLabel: 'Make adult-only permanently',
            tone: 'danger',
            required: true,
        });

        if (confirmation === null) return;
        if (!matchesNodeDomainConfirmation(confirmation, nodeDomain)) {
            showToast(`Type ${nodeDomain} exactly to confirm.`, 'error');
            return;
        }

        const previousSettings = nodeSettings;
        const nextSettings = { ...nodeSettings, isNsfw: true };
        setNodeSettings(nextSettings);

        const saved = await handleSaveSettings(nextSettings, nodeDomain);
        if (!saved) setNodeSettings(previousSettings);
    };

    const uploadBannerFile = async (file: File, allowPrompt = true) => {
        setBannerUploadError(null);
        setIsUploadingBanner(true);

        try {
            const media = await uploadMediaFile(file);

            const nextSettings = {
                ...nodeSettings,
                bannerUrl: media.url,
            };
            setNodeSettings(nextSettings);
            await handleSaveSettings(nextSettings);
            setPendingBannerFile(null);
        } catch (error) {
            if (error instanceof MediaUploadError && error.code === 'STORAGE_NOT_CONFIGURED' && allowPrompt) {
                setPendingBannerFile(file);
                setShowBannerStorageConfiguration(true);
                return;
            }
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

    const handleChooseBanner = async () => {
        if (bannerStorageCheckInFlightRef.current) return;
        bannerStorageCheckInFlightRef.current = true;
        setBannerUploadError(null);
        try {
            if (!await getStorageProvider()) {
                setShowBannerStorageConfiguration(true);
                return;
            }
            bannerInputRef.current?.click();
        } catch (error) {
            setBannerUploadError(error instanceof Error ? error.message : 'Unable to check media storage');
        } finally {
            bannerStorageCheckInFlightRef.current = false;
        }
    };

    const handleLogoUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;

        setLogoUploadError(null);
        setIsUploadingLogo(true);

        try {
            const privateFile = await stripPhotoVideoMetadata(file);
            const formData = new FormData();
            formData.append('file', privateFile);
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
            const privateFile = await stripPhotoVideoMetadata(file);
            const formData = new FormData();
            formData.append('file', privateFile);
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
                                        <Image
                                            unoptimized
                                            src={nodeSettings.logoUrl}
                                            alt="Custom logo"
                                            width={200}
                                            height={60}
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
                                        <Image
                                            unoptimized
                                            src={nodeSettings.faviconUrl}
                                            alt="Custom favicon"
                                            width={32}
                                            height={32}
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
                                    <button className="btn btn-ghost btn-sm" type="button" onClick={handleChooseBanner} disabled={isUploadingBanner}>
                                        {isUploadingBanner ? 'Uploading...' : 'Upload banner'}
                                    </button>
                                    <input
                                        ref={bannerInputRef}
                                        type="file"
                                        accept="image/*"
                                        onChange={handleBannerUpload}
                                        disabled={isUploadingBanner}
                                        style={{ display: 'none' }}
                                    />
                                    {bannerUploadError && (
                                        <span style={{ fontSize: '12px', color: 'var(--danger)' }}>{bannerUploadError}</span>
                                    )}
                                </div>
                                {nodeSettings.bannerUrl && (
                                    <div style={{ marginTop: '12px' }}>
                                        <Image
                                            unoptimized
                                            src={nodeSettings.bannerUrl}
                                            alt="Banner preview"
                                            width={520}
                                            height={220}
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
                                            Adult-only node
                                        </label>
                                        <p style={{ fontSize: '12px', color: 'var(--foreground-secondary)', margin: 0 }}>
                                            {nodeSettings.isNsfw 
                                                ? 'This node is permanently classified as adult-only. It cannot return to general-audience status.'
                                                : 'Permanently classify this node as adult-only. Every post from this node will be treated as NSFW across the swarm.'}
                                        </p>
                                    </div>
                                    <button
                                        className={`btn btn-sm ${nodeSettings.isNsfw ? 'btn-primary' : 'btn-ghost'}`}
                                        type="button"
                                        disabled={nodeSettings.isNsfw || savingSettings || !nodeDomain}
                                        style={{ 
                                            background: nodeSettings.isNsfw ? 'var(--error)' : undefined,
                                            flexShrink: 0,
                                        }}
                                        onClick={handleMakeNodeAdultOnly}
                                    >
                                        {nodeSettings.isNsfw ? 'Permanently adult-only' : 'Make adult-only'}
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
                                <button className="btn btn-primary" onClick={() => handleSaveSettings()} disabled={savingSettings || !nodeSettingsChanged}>
                                    {savingSettings ? 'Saving...' : 'Save Settings'}
                                </button>
                            </div>

                </div>
            )}

            <StorageConfigurationPrompt
                open={showBannerStorageConfiguration}
                onConfigured={async () => {
                    setShowBannerStorageConfiguration(false);
                    if (pendingBannerFile) {
                        await uploadBannerFile(pendingBannerFile, false);
                        return;
                    }
                    showToast('Stuffbox connected. Choose a banner to continue.', 'success');
                    bannerInputRef.current?.click();
                }}
                onCancel={() => {
                    setShowBannerStorageConfiguration(false);
                    setPendingBannerFile(null);
                }}
            />
        </>
    );
}
