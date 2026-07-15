'use client';

import { useState } from 'react';

interface StorageConfigurationPromptProps {
    open: boolean;
    onConfigured: () => void | Promise<void>;
    onCancel: () => void;
}

export function StorageConfigurationPrompt({
    open,
    onConfigured,
    onCancel,
}: StorageConfigurationPromptProps) {
    const [provider, setProvider] = useState('r2');
    const [endpoint, setEndpoint] = useState('');
    const [publicBaseUrl, setPublicBaseUrl] = useState('');
    const [region, setRegion] = useState('auto');
    const [bucket, setBucket] = useState('');
    const [accessKey, setAccessKey] = useState('');
    const [secretKey, setSecretKey] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    if (!open) return null;

    const needsCustomUrls = provider === 'r2' || provider === 'b2' || provider === 'contabo';

    const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setError('');
        setIsSubmitting(true);

        try {
            const response = await fetch('/api/storage/configuration', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    provider,
                    endpoint: endpoint || null,
                    publicBaseUrl: publicBaseUrl || null,
                    region,
                    bucket,
                    accessKey,
                    secretKey,
                    password,
                }),
            });
            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(data.error || 'Failed to connect storage');
            }

            await onConfigured();
        } catch (submitError) {
            setError(submitError instanceof Error ? submitError.message : 'Failed to connect storage');
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 100000,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '20px',
                background: 'rgba(0, 0, 0, 0.8)',
            }}
            onClick={onCancel}
        >
            <div className="card" style={{ width: '100%', maxWidth: '560px', maxHeight: '90vh', overflowY: 'auto', padding: '24px' }} onClick={(event) => event.stopPropagation()}>
                <h3 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '8px' }}>Connect your media storage</h3>
                <p style={{ color: 'var(--foreground-secondary)', lineHeight: 1.5, marginBottom: '20px' }}>
                    Synapsis keeps media in your own S3-compatible bucket. This is only required when you upload a photo or video.
                </p>

                <form onSubmit={handleSubmit}>
                    <label style={{ display: 'block', marginBottom: '12px' }}>
                        <span style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>Provider</span>
                        <select className="input" value={provider} onChange={(event) => setProvider(event.target.value)}>
                            <option value="r2">Cloudflare R2</option>
                            <option value="b2">Backblaze B2</option>
                            <option value="wasabi">Wasabi</option>
                            <option value="contabo">Contabo S3</option>
                            <option value="s3">AWS S3</option>
                        </select>
                    </label>

                    {needsCustomUrls && (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                            <label style={{ display: 'block', marginBottom: '12px' }}>
                                <span style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>S3 endpoint</span>
                                <input className="input" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://..." required />
                            </label>
                            <label style={{ display: 'block', marginBottom: '12px' }}>
                                <span style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>Public media URL</span>
                                <input className="input" value={publicBaseUrl} onChange={(event) => setPublicBaseUrl(event.target.value)} placeholder="https://..." required />
                            </label>
                        </div>
                    )}

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                        <label style={{ display: 'block', marginBottom: '12px' }}>
                            <span style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>Region</span>
                            <input className="input" value={region} onChange={(event) => setRegion(event.target.value)} required />
                        </label>
                        <label style={{ display: 'block', marginBottom: '12px' }}>
                            <span style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>Bucket</span>
                            <input className="input" value={bucket} onChange={(event) => setBucket(event.target.value)} required />
                        </label>
                    </div>

                    <label style={{ display: 'block', marginBottom: '12px' }}>
                        <span style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>Access key ID</span>
                        <input className="input" type="password" value={accessKey} onChange={(event) => setAccessKey(event.target.value)} required minLength={10} />
                    </label>
                    <label style={{ display: 'block', marginBottom: '12px' }}>
                        <span style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>Secret access key</span>
                        <input className="input" type="password" value={secretKey} onChange={(event) => setSecretKey(event.target.value)} required minLength={10} />
                    </label>
                    <label style={{ display: 'block', marginBottom: '12px' }}>
                        <span style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>Synapsis account password</span>
                        <input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
                        <span style={{ display: 'block', marginTop: '5px', fontSize: '12px', color: 'var(--foreground-tertiary)' }}>Used locally to encrypt these credentials before they are saved.</span>
                    </label>

                    {error && <div style={{ color: 'var(--error)', fontSize: '13px', marginBottom: '12px' }}>{error}</div>}

                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={isSubmitting}>Cancel</button>
                        <button type="submit" className="btn btn-primary" disabled={isSubmitting}>{isSubmitting ? 'Connecting...' : 'Connect and upload'}</button>
                    </div>
                </form>
            </div>
        </div>
    );
}
