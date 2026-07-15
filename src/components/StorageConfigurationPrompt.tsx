'use client';

import { useEffect, useRef, useState } from 'react';
import { Box, ChevronDown, ExternalLink } from 'lucide-react';
import { hasNewStuffboxConnection } from '@/lib/stuffbox/browser-upload';
import {
    monitorStuffboxConnection,
    StuffboxConnectionCancelledError,
    type StuffboxConnectionResult,
} from '@/lib/stuffbox/connection-monitor';

interface StorageConfigurationPromptProps {
    open: boolean;
    onConfigured: () => void | Promise<void>;
    onCancel: () => void;
    variant?: 'modal' | 'inline';
}

export function StorageConfigurationPrompt({ open, onConfigured, onCancel, variant = 'modal' }: StorageConfigurationPromptProps) {
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
    const [isLoading, setIsLoading] = useState(false);
    const [stuffboxAvailable, setStuffboxAvailable] = useState(false);
    const [showS3, setShowS3] = useState(false);
    const [isConnectingStuffbox, setIsConnectingStuffbox] = useState(false);
    const connectionAbortRef = useRef<AbortController | null>(null);
    const connectionPopupRef = useRef<Window | null>(null);

    const closeConnectionPopup = () => {
        try { connectionPopupRef.current?.close(); } catch { /* COOP may sever the popup handle. */ }
        connectionPopupRef.current = null;
    };

    const cancelStuffboxConnection = () => {
        connectionAbortRef.current?.abort();
        connectionAbortRef.current = null;
        closeConnectionPopup();
        setIsConnectingStuffbox(false);
    };

    useEffect(() => () => {
        connectionAbortRef.current?.abort();
        try { connectionPopupRef.current?.close(); } catch { /* Best-effort cleanup. */ }
    }, []);

    useEffect(() => {
        if (open) return;
        connectionAbortRef.current?.abort();
        connectionAbortRef.current = null;
        try { connectionPopupRef.current?.close(); } catch { /* Best-effort cleanup. */ }
        connectionPopupRef.current = null;
    }, [open]);

    useEffect(() => {
        if (!open) return;
        let active = true;
        setError('');
        setIsLoading(true);
        fetch('/api/storage/configuration', { cache: 'no-store' })
            .then(async (response) => {
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(data.error || 'Unable to load storage options');
                if (active) setStuffboxAvailable(Boolean(data.stuffboxAvailable));
            })
            .catch((loadError) => active && setError(loadError instanceof Error ? loadError.message : 'Unable to load storage options'))
            .finally(() => active && setIsLoading(false));
        return () => { active = false; };
    }, [open]);

    if (!open) return null;
    const needsCustomUrls = provider === 'r2' || provider === 'b2' || provider === 'contabo';

    const connectStuffbox = async () => {
        setError('');
        setIsConnectingStuffbox(true);
        const popup = window.open('', 'synapsis-stuffbox', 'popup,width=620,height=760');
        if (!popup) {
            setError('Your browser blocked the Stuffbox window. Allow popups and try again.');
            setIsConnectingStuffbox(false);
            return;
        }
        connectionPopupRef.current = popup;
        popup.document.body.textContent = 'Connecting to Stuffbox…';
        const controller = new AbortController();
        connectionAbortRef.current = controller;

        try {
            const response = await fetch('/api/storage/stuffbox/connect', {
                method: 'POST',
                signal: controller.signal,
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.authorizationUrl || !data.connectionStartedAt || !data.connectionAttempt) {
                throw new Error(data.error || 'Unable to connect Stuffbox');
            }
            const result = monitorStuffboxConnection({
                signal: controller.signal,
                checkConnected: async () => hasNewStuffboxConnection(data.connectionStartedAt),
                subscribe: (finish) => {
                    let channel: BroadcastChannel | null = null;
                    const finishCurrentAttempt = (result: StuffboxConnectionResult) => {
                        if (result.attemptId === data.connectionAttempt) finish(result);
                    };

                    function receive(event: MessageEvent) {
                        if (event.origin !== window.location.origin || event.data?.type !== 'synapsis:stuffbox') return;
                        finishCurrentAttempt(event.data as StuffboxConnectionResult);
                    }

                    function receiveStorage(event: StorageEvent) {
                        if (event.key !== 'synapsis:stuffbox:result' || !event.newValue) return;
                        try { finishCurrentAttempt(JSON.parse(event.newValue)); } catch { /* Ignore unrelated storage values. */ }
                    }

                    window.addEventListener('message', receive);
                    window.addEventListener('storage', receiveStorage);
                    if ('BroadcastChannel' in window) {
                        channel = new BroadcastChannel('synapsis:stuffbox');
                        channel.onmessage = (event) => finishCurrentAttempt(event.data);
                    }
                    return () => {
                        window.removeEventListener('message', receive);
                        window.removeEventListener('storage', receiveStorage);
                        channel?.close();
                    };
                },
            });
            popup.location.href = data.authorizationUrl;
            await result;
            window.focus();
            closeConnectionPopup();
            await onConfigured();
        } catch (connectError) {
            closeConnectionPopup();
            if (!controller.signal.aborted && !(connectError instanceof StuffboxConnectionCancelledError)) {
                setError(connectError instanceof Error ? connectError.message : 'Unable to connect Stuffbox');
            }
        } finally {
            connectionAbortRef.current = null;
            setIsConnectingStuffbox(false);
        }
    };

    const connectS3 = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setError('');
        setIsSubmitting(true);
        try {
            const response = await fetch('/api/storage/configuration', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider, endpoint: endpoint || null, publicBaseUrl: publicBaseUrl || null, region, bucket, accessKey, secretKey, password }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || 'Failed to connect storage');
            await onConfigured();
        } catch (submitError) {
            setError(submitError instanceof Error ? submitError.message : 'Failed to connect storage');
        } finally {
            setIsSubmitting(false);
        }
    };

    const content = (
        <>
            {variant === 'modal' && (
                <>
                <h3 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '8px' }}>Connect media storage</h3>
                <p style={{ color: 'var(--foreground-secondary)', lineHeight: 1.5, marginBottom: '20px' }}>
                    Your media lives outside this Synapsis node, so your account stays portable.
                </p>
                </>
            )}

            <div style={{ border: '1px solid var(--border)', borderRadius: '12px', padding: '18px', background: 'var(--background-secondary)' }}>
                    <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                        <Box size={24} style={{ flex: '0 0 auto', marginTop: '2px' }} />
                        <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 600, marginBottom: '4px' }}>Stuffbox</div>
                            <div style={{ color: 'var(--foreground-secondary)', fontSize: '14px', lineHeight: 1.45 }}>
                                Connect once, then uploads just work. You own your media and can take it anywhere.
                            </div>
                        </div>
                    </div>
                    <button type="button" className="btn btn-primary" onClick={isConnectingStuffbox ? cancelStuffboxConnection : connectStuffbox} disabled={isSubmitting || isLoading || !stuffboxAvailable} style={{ width: '100%', marginTop: '16px' }}>
                        {isConnectingStuffbox ? 'Cancel connection' : stuffboxAvailable ? <>Connect Stuffbox <ExternalLink size={15} /></> : isLoading ? 'Loading…' : 'Stuffbox unavailable on this node'}
                    </button>
                    {isConnectingStuffbox && (
                        <div style={{ color: 'var(--foreground-secondary)', fontSize: '13px', lineHeight: 1.45, marginTop: '10px', textAlign: 'center' }}>
                            Approve access in the Stuffbox window. This page will continue automatically.
                        </div>
                    )}
            </div>

            <button type="button" className="btn btn-ghost" onClick={() => { setShowS3((value) => !value); setError(''); }} disabled={isConnectingStuffbox} style={{ width: '100%', marginTop: '12px', justifyContent: 'space-between' }}>
                Use your own S3-compatible bucket <ChevronDown size={16} style={{ transform: showS3 ? 'rotate(180deg)' : undefined }} />
            </button>

            {showS3 && (
                <form onSubmit={connectS3} style={{ marginTop: '16px' }}>
                        <p style={{ color: 'var(--foreground-tertiary)', fontSize: '13px', lineHeight: 1.45, marginBottom: '14px' }}>
                            Advanced option. Credentials are encrypted locally; you may need to confirm your password again after the node restarts.
                        </p>
                        <label style={{ display: 'block', marginBottom: '12px' }}>
                            <span style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>Provider</span>
                            <select className="input" value={provider} onChange={(event) => setProvider(event.target.value)}>
                                <option value="r2">Cloudflare R2</option><option value="b2">Backblaze B2</option><option value="wasabi">Wasabi</option><option value="contabo">Contabo S3</option><option value="s3">AWS S3</option>
                            </select>
                        </label>
                        {needsCustomUrls && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                            <Field label="S3 endpoint" value={endpoint} onChange={setEndpoint} placeholder="https://…" />
                            <Field label="Public media URL" value={publicBaseUrl} onChange={setPublicBaseUrl} placeholder="https://…" />
                        </div>}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                            <Field label="Region" value={region} onChange={setRegion} />
                            <Field label="Bucket" value={bucket} onChange={setBucket} />
                        </div>
                        <Field label="Access key ID" value={accessKey} onChange={setAccessKey} type="password" minLength={10} />
                        <Field label="Secret access key" value={secretKey} onChange={setSecretKey} type="password" minLength={10} />
                        <Field label="Synapsis account password" value={password} onChange={setPassword} type="password" />
                        <button type="submit" className="btn btn-primary" disabled={isSubmitting} style={{ width: '100%' }}>{isSubmitting ? 'Connecting…' : 'Connect S3 storage'}</button>
                </form>
            )}

            {error && <div style={{ color: 'var(--error)', fontSize: '13px', marginTop: '14px' }}>{error}</div>}
            {variant === 'modal' && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px' }}><button type="button" className="btn btn-ghost" onClick={() => { cancelStuffboxConnection(); onCancel(); }} disabled={isSubmitting}>Cancel</button></div>
            )}
        </>
    );

    if (variant === 'inline') return content;

    return (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', background: 'rgba(0, 0, 0, 0.8)' }} onClick={() => { cancelStuffboxConnection(); onCancel(); }}>
            <div className="card" style={{ width: '100%', maxWidth: '560px', maxHeight: '90vh', overflowY: 'auto', padding: '24px' }} onClick={(event) => event.stopPropagation()}>
                {content}
            </div>
        </div>
    );
}

function Field({ label, value, onChange, type = 'text', placeholder, minLength }: { label: string; value: string; onChange: (value: string) => void; type?: string; placeholder?: string; minLength?: number }) {
    return <label style={{ display: 'block', marginBottom: '12px' }}>
        <span style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>{label}</span>
        <input className="input" type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} required minLength={minLength} />
    </label>;
}
