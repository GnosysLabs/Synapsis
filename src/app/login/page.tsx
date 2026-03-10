'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { TriangleAlert, X } from 'lucide-react';
import { decryptPrivateKey } from '@/lib/crypto/private-key-client';
import { keyStore, importPrivateKey } from '@/lib/crypto/user-signing';
import { useAuth } from '@/lib/contexts/AuthContext';

declare global {
    interface Window {
        turnstile?: {
            render: (element: string | HTMLElement, options: {
                sitekey: string;
                callback?: (token: string) => void;
                'error-callback'?: () => void;
                'expired-callback'?: () => void;
            }) => string;
            reset: (widgetId: string) => void;
            remove: (widgetId: string) => void;
        };
    }
}

interface AuthScreenProps {
    modal?: boolean;
    onClose?: () => void;
    onSuccess?: () => void;
}

export function AuthScreen({ modal = false, onClose, onSuccess }: AuthScreenProps) {
    const router = useRouter();
    const [mode, setMode] = useState<'login' | 'register' | 'import'>('login');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [handle, setHandle] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [storageProvider, setStorageProvider] = useState('r2');
    const [storageEndpoint, setStorageEndpoint] = useState('');
    const [storagePublicBaseUrl, setStoragePublicBaseUrl] = useState('');
    const [storageRegion, setStorageRegion] = useState('auto');
    const [storageBucket, setStorageBucket] = useState('');
    const [storageAccessKey, setStorageAccessKey] = useState('');
    const [storageSecretKey, setStorageSecretKey] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [nodeInfoLoaded, setNodeInfoLoaded] = useState(false);
    const [nodeInfo, setNodeInfo] = useState<{ name: string; description: string; logoUrl?: string; isNsfw?: boolean; turnstileSiteKey?: string | null }>({ name: '', description: '' });
    const [handleStatus, setHandleStatus] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle');
    const [ageVerified, setAgeVerified] = useState(false);
    const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
    const [turnstileLoaded, setTurnstileLoaded] = useState(false);
    const turnstileRef = useRef<HTMLDivElement>(null);
    const turnstileWidgetId = useRef<string | null>(null);

    const { unlockIdentity, login } = useAuth();

    const [importFile, setImportFile] = useState<File | null>(null);
    const [importPassword, setImportPassword] = useState('');
    const [importHandle, setImportHandle] = useState('');
    const [acceptedCompliance, setAcceptedCompliance] = useState(false);
    const [importAgeVerified, setImportAgeVerified] = useState(false);
    const [importSuccess, setImportSuccess] = useState<string | null>(null);

    // Fetch node info
    useEffect(() => {
        fetch('/api/node')
            .then(res => res.json())
            .then(data => {
                setNodeInfo({
                    name: data.name || '',
                    description: data.description || 'Synapsis is designed to function like a global signal layer rather than a culture-bound platform. Anyone can run their own node and still participate in a shared, interconnected network, with global identity, clean terminology, and a modern interface that feels current rather than experimental. Synapsis aims to be neutral, resilient infrastructure for human and machine discourse, more like a protocol or nervous system than a social club.',
                    logoUrl: data.logoUrl || undefined,
                    isNsfw: data.isNsfw || false,
                    turnstileSiteKey: data.turnstileSiteKey || null,
                });
                // Update page title
                if (data.name && data.name !== 'Synapsis') {
                    document.title = data.name;
                }
                setNodeInfoLoaded(true);
            })
            .catch(() => {
                setNodeInfoLoaded(true);
            });
    }, []);

    // Load Turnstile script if site key is available
    useEffect(() => {
        if (!nodeInfo.turnstileSiteKey) return;

        const script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
        script.async = true;
        script.defer = true;
        script.onload = () => setTurnstileLoaded(true);
        document.head.appendChild(script);

        return () => {
            document.head.removeChild(script);
        };
    }, [nodeInfo.turnstileSiteKey]);

    // Render Turnstile widget when ready
    useEffect(() => {
        if (!turnstileLoaded || !nodeInfo.turnstileSiteKey || !turnstileRef.current || mode === 'import') return;

        // Clean up previous widget
        if (turnstileWidgetId.current && window.turnstile) {
            try {
                window.turnstile.remove(turnstileWidgetId.current);
            } catch (e) {
                // Ignore errors
            }
        }

        // Render new widget
        if (window.turnstile) {
            turnstileWidgetId.current = window.turnstile.render(turnstileRef.current, {
                sitekey: nodeInfo.turnstileSiteKey,
                callback: (token: string) => {
                    setTurnstileToken(token);
                },
                'error-callback': () => {
                    setTurnstileToken(null);
                },
                'expired-callback': () => {
                    setTurnstileToken(null);
                },
            });
        }

        return () => {
            if (turnstileWidgetId.current && window.turnstile) {
                try {
                    window.turnstile.remove(turnstileWidgetId.current);
                } catch (e) {
                    // Ignore errors
                }
            }
        };
    }, [turnstileLoaded, nodeInfo.turnstileSiteKey, mode]);

    // Handle availability check
    useEffect(() => {
        const checkHandle = mode === 'register' ? handle : (mode === 'import' ? importHandle : '');
        if (!checkHandle || checkHandle.length < 3) {
            setHandleStatus('idle');
            return;
        }

        const timer = setTimeout(async () => {
            setHandleStatus('checking');
            try {
                const res = await fetch(`/api/auth/check-handle?handle=${checkHandle}`);
                const data = await res.json();
                if (data.available) {
                    setHandleStatus('available');
                } else {
                    setHandleStatus('taken');
                }
            } catch {
                setHandleStatus('idle');
            }
        }, 500);

        return () => clearTimeout(timer);
    }, [handle, importHandle, mode]);

    const handleImport = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!importFile || !importPassword || !importHandle || !acceptedCompliance) {
            setError('Please fill in all fields and accept the compliance agreement');
            return;
        }

        if (nodeInfo.isNsfw && !importAgeVerified) {
            setError('You must verify your age to import an account on this node');
            return;
        }

        setLoading(true);
        setError('');
        setImportSuccess(null);

        try {
            const fileContent = await importFile.text();
            const exportData = JSON.parse(fileContent);

            const res = await fetch('/api/account/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    exportData,
                    password: importPassword,
                    newHandle: importHandle,
                    acceptedCompliance,
                }),
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || 'Import failed');
            }

            setImportSuccess(data.message);
            // Soft navigation to preserve AuthContext/KeyStore state
            setTimeout(() => {
                router.refresh();
                if (onSuccess) {
                    onSuccess();
                } else {
                    router.push('/');
                }
            }, 2000);

        } catch (err) {
            setError(err instanceof Error ? err.message : 'Import failed');
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');

        if (mode === 'register' && password !== confirmPassword) {
            setError('Passwords do not match');
            return;
        }

        if (mode === 'register' && nodeInfo.isNsfw && !ageVerified) {
            setError('You must verify your age to register on this node');
            return;
        }

        // Check if Turnstile is required but not completed
        if (nodeInfo.turnstileSiteKey && !turnstileToken) {
            setError('Please complete the verification challenge');
            return;
        }

        setLoading(true);

        try {
            const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';

            // Only include turnstileToken if Turnstile is enabled (site key exists)
            const body = mode === 'login'
                ? {
                    email,
                    password,
                    ...(nodeInfo.turnstileSiteKey ? { turnstileToken } : {})
                }
                : {
                    email,
                    password,
                    handle,
                    displayName,
                    storageProvider,
                    storageEndpoint: storageEndpoint || null,
                    storagePublicBaseUrl: storagePublicBaseUrl || null,
                    storageRegion,
                    storageBucket,
                    storageAccessKey,
                    storageSecretKey,
                    ...(nodeInfo.turnstileSiteKey ? { turnstileToken } : {})
                };

            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || 'Authentication failed');
            }

            // Decrypt and store private key if available
            if (data.user?.privateKeyEncrypted) {
                try {
                    const privateKeyDecrypted = await decryptPrivateKey(
                        data.user.privateKeyEncrypted,
                        password
                    );

                    // Import and set in memory store
                    // Remove PEM headers if present and clean whitespace
                    let cleanKey = privateKeyDecrypted
                        .replace(/-----BEGIN [A-Z ]+-----/, '')
                        .replace(/-----END [A-Z ]+-----/, '')
                        .replace(/\s/g, '');

                    const binaryDer = Buffer.from(cleanKey, 'base64');
                    const cryptoKey = await importPrivateKey(binaryDer);

                    keyStore.setPrivateKey(cryptoKey);

                    console.log('[Auth] Private key decrypted and stored successfully');
                } catch (decryptError) {
                    console.error('[Auth] Failed to decrypt private key:', decryptError);
                    // Don't block login/registration if decryption fails - user can unlock later
                    // The identity unlock prompt will be shown in the app
                }
            } else {
                if (process.env.NODE_ENV === 'development') console.log('[Auth] No encrypted private key returned from server');
            }

            // Sync with global auth state if we have a key (or even if we don't, to trigger load)
            // But unlockIdentity specifically needs the key. 
            // If data.user.privateKeyEncrypted is present, we try to unlock globally.
            if (data.user?.privateKeyEncrypted) {
                try {
                    // Update AuthContext first so it has the user and key
                    login(data.user);

                    // Now unlock (passing user explicitly to avoid async state delay)
                    await unlockIdentity(password, data.user);
                } catch (e) {
                    console.error("Failed to auto-unlock identity:", e);
                }
            }

            // Soft navigation to preserve AuthContext/KeyStore state
            router.refresh();
            if (onSuccess) {
                onSuccess();
            } else {
                router.push('/');
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
            // Reset Turnstile on error
            if (turnstileWidgetId.current && window.turnstile) {
                window.turnstile.reset(turnstileWidgetId.current);
                setTurnstileToken(null);
            }
        } finally {
            setLoading(false);
        }
    };

    const content = (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: modal ? '0' : '24px',
        }}>
            <div style={{
                width: '100%',
                maxWidth: mode === 'register' ? '680px' : '400px',
            }}>
                {/* Logo */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '32px', minHeight: '120px' }}>
                    {nodeInfoLoaded && (
                        <>
                            {nodeInfo.logoUrl ? (
                                <Image
                                    src={nodeInfo.logoUrl}
                                    alt={nodeInfo.name || 'Node logo'}
                                    width={200}
                                    height={60}
                                    style={{ marginBottom: '16px', objectFit: 'contain', maxHeight: '60px', width: 'auto' }}
                                    unoptimized
                                />
                            ) : (
                                <Image
                                    src="/logotext.svg"
                                    alt="Synapsis"
                                    width={200}
                                    height={48}
                                    style={{ marginBottom: '16px', objectFit: 'contain' }}
                                    priority
                                />
                            )}
                            {nodeInfo.name && nodeInfo.name !== 'Synapsis' && !nodeInfo.logoUrl && (
                                <div style={{ fontSize: '18px', fontWeight: 600, color: 'var(--foreground)', marginBottom: '8px' }}>
                                    {nodeInfo.name}
                                </div>
                            )}
                            <p style={{ color: 'var(--foreground-secondary)', marginTop: '0', textAlign: 'center' }}>
                                {nodeInfo.description}
                            </p>
                        </>
                    )}
                </div>

                {/* Mode Switcher */}
                <div style={{
                    display: 'flex',
                    marginBottom: '24px',
                    background: 'var(--background-secondary)',
                    borderRadius: 'var(--radius-md)',
                    padding: '4px',
                    gap: '4px'
                }}>
                    <button
                        onClick={() => setMode('login')}
                        style={{
                            flex: 1,
                            padding: '10px',
                            border: 'none',
                            borderRadius: 'var(--radius-sm)',
                            background: mode === 'login' ? 'var(--background-tertiary)' : 'transparent',
                            color: mode === 'login' ? 'var(--foreground)' : 'var(--foreground-secondary)',
                            fontWeight: 500,
                            cursor: 'pointer',
                            transition: 'all 0.15s ease',
                        }}
                    >
                        Login
                    </button>
                    <button
                        onClick={() => setMode('register')}
                        style={{
                            flex: 1,
                            padding: '10px',
                            border: 'none',
                            borderRadius: 'var(--radius-sm)',
                            background: mode === 'register' ? 'var(--background-tertiary)' : 'transparent',
                            color: mode === 'register' ? 'var(--foreground)' : 'var(--foreground-secondary)',
                            fontWeight: 500,
                            cursor: 'pointer',
                            transition: 'all 0.15s ease',
                        }}
                    >
                        Register
                    </button>
                    <button
                        onClick={() => setMode('import')}
                        style={{
                            flex: 1,
                            padding: '10px',
                            border: 'none',
                            borderRadius: 'var(--radius-sm)',
                            background: mode === 'import' ? 'var(--background-tertiary)' : 'transparent',
                            color: mode === 'import' ? 'var(--foreground)' : 'var(--foreground-secondary)',
                            fontWeight: 500,
                            cursor: 'pointer',
                            transition: 'all 0.15s ease',
                        }}
                    >
                        Import
                    </button>
                </div>

                {/* Form */}
                {mode !== 'import' ? (
                    <form onSubmit={handleSubmit} className="card" style={{ padding: '24px' }}>
                        {error && (
                            <div style={{
                                padding: '12px',
                                marginBottom: '16px',
                                background: 'rgba(239, 68, 68, 0.1)',
                                border: '1px solid var(--error)',
                                borderRadius: 'var(--radius-md)',
                                color: 'var(--error)',
                                fontSize: '14px',
                            }}>
                                {error}
                            </div>
                        )}

                        {mode === 'register' && (
                            <>
                                {/* Row 1: Handle | Password */}
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
                                    <div>
                                        <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>
                                            Handle
                                        </label>
                                        <div style={{ position: 'relative' }}>
                                            <span style={{
                                                position: 'absolute',
                                                left: '12px',
                                                top: '50%',
                                                transform: 'translateY(-50%)',
                                                color: 'var(--foreground-tertiary)',
                                            }}>@</span>
                                            <input
                                                type="text"
                                                className="input"
                                                value={handle}
                                                onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                                                style={{ paddingLeft: '28px' }}
                                                placeholder="yourhandle"
                                                required
                                                minLength={3}
                                                maxLength={20}
                                            />
                                        </div>
                                        <div style={{
                                            fontSize: '12px',
                                            marginTop: '4px',
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            alignItems: 'center'
                                        }}>
                                            <span style={{ color: 'var(--foreground-tertiary)' }}>
                                                3-20 chars, a-z 0-9 _
                                            </span>
                                            {handleStatus === 'checking' && (
                                                <span style={{ color: 'var(--foreground-tertiary)' }}>Checking...</span>
                                            )}
                                            {handleStatus === 'available' && (
                                                <span style={{ color: 'var(--success)', fontWeight: 600 }}>✓</span>
                                            )}
                                            {handleStatus === 'taken' && (
                                                <span style={{ color: 'var(--error)', fontWeight: 600 }}>Taken</span>
                                            )}
                                        </div>
                                    </div>
                                    <div>
                                        <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>
                                            Password
                                        </label>
                                        <input
                                            type="password"
                                            className="input"
                                            value={password}
                                            onChange={(e) => setPassword(e.target.value)}
                                            placeholder="••••••••"
                                            required
                                            minLength={8}
                                        />
                                    </div>
                                </div>

                                {/* Row 2: Display Name | Confirm Password */}
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
                                    <div>
                                        <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>
                                            Display Name
                                        </label>
                                        <input
                                            type="text"
                                            className="input"
                                            value={displayName}
                                            onChange={(e) => setDisplayName(e.target.value)}
                                            placeholder="Your Name"
                                        />
                                    </div>
                                    <div>
                                        <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>
                                            Confirm Password
                                        </label>
                                        <input
                                            type="password"
                                            className="input"
                                            value={confirmPassword}
                                            onChange={(e) => setConfirmPassword(e.target.value)}
                                            placeholder="••••••••"
                                            required
                                            minLength={8}
                                        />
                                    </div>
                                </div>

                                {/* Row 3: Email | Storage Provider */}
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
                                    <div>
                                        <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>
                                            Email
                                        </label>
                                        <input
                                            type="email"
                                            className="input"
                                            value={email}
                                            onChange={(e) => setEmail(e.target.value)}
                                            placeholder="you@example.com"
                                            required
                                        />
                                    </div>
                                    <div>
                                        <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>
                                            Storage Provider
                                        </label>
                                        <select
                                            className="input"
                                            value={storageProvider}
                                            onChange={(e) => setStorageProvider(e.target.value)}
                                            style={{ cursor: 'pointer' }}
                                        >
                                            <option value="r2">Cloudflare R2 (10GB free)</option>
                                            <option value="b2">Backblaze B2 (10GB free)</option>
                                            <option value="wasabi">Wasabi</option>
                                            <option value="contabo">Contabo S3</option>
                                            <option value="s3">AWS S3</option>
                                        </select>
                                    </div>
                                </div>

                                {/* Storage Explainer Section */}
                                <div style={{
                                    marginBottom: '20px',
                                    padding: '16px',
                                    background: 'var(--background-secondary)',
                                    border: '1px solid var(--border)',
                                    borderRadius: 'var(--radius-md)',
                                }}>
                                    <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px', color: 'var(--foreground)' }}>
                                        🗄️ Why do I need to provide storage?
                                    </div>
                                    <div style={{ fontSize: '13px', color: 'var(--foreground-secondary)', lineHeight: 1.5, marginBottom: '12px' }}>
                                        Synapsis is <strong>decentralized</strong> — unlike other platforms, we don't store your photos, videos, or files on our servers. 
                                        Instead, you connect your own S3-compatible storage bucket (like Cloudflare R2 or Backblaze B2) where your media lives.
                                    </div>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
                                        <div style={{ fontSize: '12px', color: 'var(--foreground-tertiary)' }}>
                                            <strong style={{ color: 'var(--success)' }}>✓ You own your data</strong><br/>
                                            Your files stay in your bucket, not ours
                                        </div>
                                        <div style={{ fontSize: '12px', color: 'var(--foreground-tertiary)' }}>
                                            <strong style={{ color: 'var(--success)' }}>✓ Portable</strong><br/>
                                            Take your media with you if you leave
                                        </div>
                                        <div style={{ fontSize: '12px', color: 'var(--foreground-tertiary)' }}>
                                            <strong style={{ color: 'var(--success)' }}>✓ Free options</strong><br/>
                                            R2 and B2 offer 10GB free
                                        </div>
                                    </div>
                                </div>

                                {/* Endpoint URL - only show for providers that need it (R2, B2, Contabo) */}
                                {(storageProvider === 'r2' || storageProvider === 'b2' || storageProvider === 'contabo') && (
                                    <div style={{ marginBottom: '16px' }}>
                                        <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>
                                            Endpoint URL
                                        </label>
                                        <input
                                            type="text"
                                            className="input"
                                            value={storageEndpoint}
                                            onChange={(e) => setStorageEndpoint(e.target.value)}
                                            placeholder={storageProvider === 'contabo' ? 'https://s3.eu2.contabo.com' : 'https://<account>.r2.cloudflarestorage.com'}
                                            required
                                        />
                                        <div style={{ fontSize: '11px', color: 'var(--foreground-tertiary)', marginTop: '4px' }}>
                                            {storageProvider === 'contabo' ? 'S3 API endpoint from Contabo dashboard (e.g., https://s3.eu2.contabo.com)' :
                                             'S3-compatible endpoint URL for uploads.'}
                                        </div>
                                    </div>
                                )}

                                {/* Public Base URL - only show for providers that need it (R2, B2, Contabo) */}
                                {(storageProvider === 'r2' || storageProvider === 'b2' || storageProvider === 'contabo') && (
                                    <div style={{ marginBottom: '16px' }}>
                                        <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>
                                            Public Base URL
                                        </label>
                                        <input
                                            type="text"
                                            className="input"
                                            value={storagePublicBaseUrl}
                                            onChange={(e) => setStoragePublicBaseUrl(e.target.value)}
                                            placeholder={storageProvider === 'contabo' ? 'https://usc1.contabostorage.com/d5bec82ae49b444d8314dcb13654dd1d:your-bucket' : 'https://pub-xxx.r2.dev'}
                                            required
                                        />
                                        <div style={{ fontSize: '11px', color: 'var(--foreground-tertiary)', marginTop: '4px' }}>
                                            {storageProvider === 'contabo' ? 'Public URL from Contabo (format: https://region.contabostorage.com/account-id:bucket)' :
                                             storageProvider === 'r2' ? 'Public bucket URL from R2 dashboard (e.g., https://pub-xxx.r2.dev)' :
                                             storageProvider === 'b2' ? 'Public bucket URL from B2 dashboard (e.g., https://f000.backblazeb2.com/file/bucket)' :
                                             'Public URL where files are accessible (without trailing slash)'}
                                        </div>
                                    </div>
                                )}

                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
                                    <div>
                                        <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>
                                            Region
                                        </label>
                                        <input
                                            type="text"
                                            className="input"
                                            value={storageRegion}
                                            onChange={(e) => setStorageRegion(e.target.value)}
                                            placeholder="auto"
                                            required
                                        />
                                    </div>
                                    <div>
                                        <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>
                                            Bucket Name
                                        </label>
                                        <input
                                            type="text"
                                            className="input"
                                            value={storageBucket}
                                            onChange={(e) => setStorageBucket(e.target.value)}
                                            placeholder="my-synapsis-bucket"
                                            required
                                        />
                                    </div>
                                </div>

                                <div style={{ marginBottom: '16px' }}>
                                    <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>
                                        Access Key ID
                                    </label>
                                    <input
                                        type="password"
                                        className="input"
                                        value={storageAccessKey}
                                        onChange={(e) => setStorageAccessKey(e.target.value)}
                                        placeholder="AKIA..."
                                        required
                                    />
                                </div>

                                <div style={{ marginBottom: '16px' }}>
                                    <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>
                                        Secret Access Key
                                    </label>
                                    <input
                                        type="password"
                                        className="input"
                                        value={storageSecretKey}
                                        onChange={(e) => setStorageSecretKey(e.target.value)}
                                        placeholder="••••••••"
                                        required
                                    />
                                    <div style={{ fontSize: '12px', color: 'var(--foreground-tertiary)', marginTop: '4px' }}>
                                        Get free S3 storage at <a href="https://dash.cloudflare.com/sign-up/r2" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>Cloudflare R2</a> (10GB free) or <a href="https://www.backblaze.com/b2/sign-up.html" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>Backblaze B2</a>
                                    </div>
                                </div>
                            </>
                        )}

                        {/* Login Mode - Show email/password only */}
                        {mode === 'login' && (
                            <>
                                <div style={{ marginBottom: '16px' }}>
                                    <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>
                                        Email
                                    </label>
                                    <input
                                        type="email"
                                        className="input"
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        placeholder="you@example.com"
                                        required
                                    />
                                </div>

                                <div style={{ marginBottom: '24px' }}>
                                    <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>
                                        Password
                                    </label>
                                    <input
                                        type="password"
                                        className="input"
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        placeholder="••••••••"
                                        required
                                        minLength={8}
                                    />
                                </div>
                            </>
                        )}

                        {mode === 'register' && nodeInfo.isNsfw && (
                            <div style={{
                                marginBottom: '20px',
                                padding: '12px',
                                background: 'rgba(239, 68, 68, 0.05)',
                                border: '1px solid rgba(239, 68, 68, 0.2)',
                                borderRadius: 'var(--radius-md)',
                            }}>
                                <label style={{ display: 'flex', gap: '8px', cursor: 'pointer' }}>
                                    <input
                                        type="checkbox"
                                        checked={ageVerified}
                                        onChange={(e) => setAgeVerified(e.target.checked)}
                                        style={{ marginTop: '3px' }}
                                    />
                                    <span style={{ fontSize: '12px', color: 'var(--foreground-secondary)', lineHeight: 1.4 }}>
                                        <strong style={{ color: 'var(--error)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                                            <TriangleAlert size={12} /> Age Verification:
                                        </strong> This node contains adult or sensitive content. I confirm that I am at least 18 years of age.
                                    </span>
                                </label>
                            </div>
                        )}

                        {nodeInfo.turnstileSiteKey && (
                            <div style={{ marginBottom: '20px', display: 'flex', justifyContent: 'center' }}>
                                <div ref={turnstileRef}></div>
                            </div>
                        )}

                        <button
                            type="submit"
                            className="btn btn-primary btn-lg"
                            style={{ width: '100%' }}
                            disabled={loading || 
                                (!!nodeInfo.turnstileSiteKey && !turnstileToken) ||
                                (mode === 'register' && (
                                    !handle || handle.length < 3 ||
                                    !email ||
                                    !password || password.length < 8 ||
                                    !confirmPassword ||
                                    password !== confirmPassword ||
                                    !storageProvider ||
                                    !storageRegion ||
                                    !storageBucket ||
                                    !storageAccessKey ||
                                    !storageSecretKey ||
                                    (nodeInfo.isNsfw && !ageVerified)
                                ))}
                        >
                            {loading ? 'Please wait...' : (mode === 'login' ? 'Login' : 'Create Account')}
                        </button>
                    </form>
                ) : (
                    <form onSubmit={handleImport} className="card" style={{ padding: '24px' }}>
                        {error && (
                            <div style={{
                                padding: '12px',
                                marginBottom: '16px',
                                background: 'rgba(239, 68, 68, 0.1)',
                                border: '1px solid var(--error)',
                                borderRadius: 'var(--radius-md)',
                                color: 'var(--error)',
                                fontSize: '14px',
                            }}>
                                {error}
                            </div>
                        )}

                        {importSuccess && (
                            <div style={{
                                padding: '12px',
                                marginBottom: '16px',
                                background: 'var(--success)',
                                border: '1px solid var(--success)',
                                borderRadius: 'var(--radius-md)',
                                color: '#000',
                                fontSize: '14px',
                            }}>
                                {importSuccess} Redirecting...
                            </div>
                        )}

                        <div style={{ marginBottom: '16px' }}>
                            <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>
                                Export file
                            </label>
                            <div style={{ position: 'relative' }}>
                                <input
                                    type="file"
                                    id="import-file-input"
                                    accept=".json"
                                    onChange={(e) => setImportFile(e.target.files?.[0] || null)}
                                    style={{ display: 'none' }}
                                />
                                <label
                                    htmlFor="import-file-input"
                                    className="input"
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        cursor: 'pointer',
                                        color: importFile ? 'var(--foreground)' : 'var(--foreground-tertiary)',
                                        fontSize: '14px'
                                    }}
                                >
                                    <span>{importFile ? importFile.name : 'Select export file...'}</span>
                                    <span className="btn btn-ghost btn-sm" style={{ pointerEvents: 'none', padding: '4px 8px', height: 'auto', minHeight: 'unset' }}>
                                        Browse
                                    </span>
                                </label>
                            </div>
                        </div>

                        <div style={{ marginBottom: '16px' }}>
                            <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>
                                Password (from your old account)
                            </label>
                            <input
                                type="password"
                                className="input"
                                value={importPassword}
                                onChange={(e) => setImportPassword(e.target.value)}
                                placeholder="Enter the password for this account"
                                required
                            />
                        </div>

                        <div style={{ marginBottom: '16px' }}>
                            <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>
                                Handle on this node
                            </label>
                            <div style={{ position: 'relative' }}>
                                <span style={{
                                    position: 'absolute',
                                    left: '12px',
                                    top: '50%',
                                    transform: 'translateY(-50%)',
                                    color: 'var(--foreground-tertiary)',
                                }}>@</span>
                                <input
                                    type="text"
                                    className="input"
                                    value={importHandle}
                                    onChange={(e) => setImportHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                                    style={{ paddingLeft: '28px' }}
                                    placeholder="yourhandle"
                                    required
                                    minLength={3}
                                    maxLength={20}
                                />
                            </div>
                            <div style={{
                                fontSize: '12px',
                                marginTop: '4px',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center'
                            }}>
                                <span style={{ color: 'var(--foreground-tertiary)' }}>
                                    3-20 chars
                                </span>
                                {handleStatus === 'checking' && (
                                    <span style={{ color: 'var(--foreground-tertiary)' }}>Checking...</span>
                                )}
                                {handleStatus === 'available' && (
                                    <span style={{ color: 'var(--success)', fontWeight: 600 }}>Available</span>
                                )}
                                {handleStatus === 'taken' && (
                                    <span style={{ color: 'var(--error)', fontWeight: 600 }}>Taken</span>
                                )}
                            </div>
                        </div>

                        <div style={{
                            marginBottom: '20px',
                            padding: '12px',
                            background: 'rgba(245, 158, 11, 0.05)',
                            border: '1px solid rgba(245, 158, 11, 0.2)',
                            borderRadius: 'var(--radius-md)',
                        }}>
                            <label style={{ display: 'flex', gap: '8px', cursor: 'pointer' }}>
                                <input
                                    type="checkbox"
                                    checked={acceptedCompliance}
                                    onChange={(e) => setAcceptedCompliance(e.target.checked)}
                                    style={{ marginTop: '3px' }}
                                />
                                <span style={{ fontSize: '12px', color: 'var(--foreground-secondary)', lineHeight: 1.4 }}>
                                    <strong style={{ color: 'var(--warning)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                                        <TriangleAlert size={12} /> Compliance:
                                    </strong> I agree to comply with this node's rules and take responsibility for my migrated content.
                                </span>
                            </label>
                        </div>

                        {nodeInfo.isNsfw && (
                            <div style={{
                                marginBottom: '20px',
                                padding: '12px',
                                background: 'rgba(239, 68, 68, 0.05)',
                                border: '1px solid rgba(239, 68, 68, 0.2)',
                                borderRadius: 'var(--radius-md)',
                            }}>
                                <label style={{ display: 'flex', gap: '8px', cursor: 'pointer' }}>
                                    <input
                                        type="checkbox"
                                        checked={importAgeVerified}
                                        onChange={(e) => setImportAgeVerified(e.target.checked)}
                                        style={{ marginTop: '3px' }}
                                    />
                                    <span style={{ fontSize: '12px', color: 'var(--foreground-secondary)', lineHeight: 1.4 }}>
                                        <strong style={{ color: 'var(--error)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                                            <TriangleAlert size={12} /> Age Verification:
                                        </strong> This node contains adult or sensitive content. I confirm that I am at least 18 years of age.
                                    </span>
                                </label>
                            </div>
                        )}

                        <button
                            type="submit"
                            className="btn btn-primary btn-lg"
                            style={{ width: '100%' }}
                            disabled={loading || !importFile || !importPassword || !importHandle || !acceptedCompliance || (nodeInfo.isNsfw && !importAgeVerified)}
                        >
                            {loading ? 'Importing...' : 'Import Account'}
                        </button>
                    </form>
                )}

                {!modal && (
                    <p style={{ textAlign: 'center', marginTop: '24px', color: 'var(--foreground-tertiary)', fontSize: '14px' }}>
                        <Link href="/">← Back to home</Link>
                    </p>
                )}
            </div>
        </div>
    );

    if (modal) {
        return (
            <div
                style={{
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(0, 0, 0, 0.72)',
                    backdropFilter: 'blur(10px)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '24px',
                    zIndex: 120,
                }}
                onClick={onClose}
            >
                <div
                    style={{
                        position: 'relative',
                        width: 'min(760px, 100%)',
                    }}
                    onClick={(event) => event.stopPropagation()}
                >
                    {onClose && (
                        <button
                            onClick={onClose}
                            aria-label="Close"
                            style={{
                                position: 'absolute',
                                top: '18px',
                                right: '18px',
                                width: '44px',
                                height: '44px',
                                borderRadius: '999px',
                                border: '1px solid var(--border)',
                                background: 'rgba(0, 0, 0, 0.78)',
                                color: 'var(--foreground)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                cursor: 'pointer',
                                zIndex: 3,
                            }}
                        >
                            <X size={20} />
                        </button>
                    )}
                    <div
                    className="card"
                    style={{
                        maxHeight: 'calc(100vh - 48px)',
                        overflowY: 'auto',
                        padding: '28px',
                        background: 'rgba(10, 10, 10, 0.98)',
                        boxShadow: '0 30px 90px rgba(0, 0, 0, 0.55)',
                    }}
                    >
                        {content}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div style={{ minHeight: '100vh' }}>
            {content}
        </div>
    );
}

export default function LoginPage() {
    return <AuthScreen />;
}
