'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, Download, TriangleAlert, X } from 'lucide-react';
import { useAuth } from '@/lib/contexts/AuthContext';
import { completePostSignInNavigation } from '@/lib/auth/post-sign-in-navigation';
import { getIosAppStoreUrl, getSafeIosPublicUrl } from '@/lib/platform/ios-web-funnel';

const DEFAULT_NODE_DESCRIPTION = 'A swarm social network node.';

declare global {
    interface Window {
        turnstile?: {
            render: (element: string | HTMLElement, options: {
                sitekey: string;
                action?: 'login' | 'register';
                retry?: 'auto' | 'never';
                callback?: (token: string) => void;
                'error-callback'?: (errorCode: string) => void;
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
    iosFunnel?: boolean;
    initialMode?: 'login' | 'register';
}

export function AuthScreen({
    modal = false,
    onClose,
    onSuccess,
    iosFunnel = false,
    initialMode = 'login',
}: AuthScreenProps) {
    const router = useRouter();
    const [mode, setMode] = useState<'login' | 'register' | 'import'>(iosFunnel ? 'register' : initialMode);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [handle, setHandle] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [nodeInfoLoaded, setNodeInfoLoaded] = useState(false);
    const [nodeInfoUnavailable, setNodeInfoUnavailable] = useState(false);
    const [nodeInfo, setNodeInfo] = useState<{ name: string; description: string; logoUrl?: string; isNsfw?: boolean; turnstileSiteKey?: string | null }>({ name: '', description: DEFAULT_NODE_DESCRIPTION });
    const [handleStatus, setHandleStatus] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle');
    const [ageVerified, setAgeVerified] = useState(false);
    const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
    const [turnstileLoaded, setTurnstileLoaded] = useState(false);
    const [turnstileRequired, setTurnstileRequired] = useState(false);
    const [turnstileError, setTurnstileError] = useState('');
    const turnstileRef = useRef<HTMLDivElement>(null);
    const turnstileWidgetId = useRef<string | null>(null);
    const iosAppUrl = getSafeIosPublicUrl(process.env.NEXT_PUBLIC_IOS_APP_URL, true);
    const iosAppStoreUrl = getIosAppStoreUrl(process.env.NEXT_PUBLIC_IOS_APP_STORE_URL);
    const existingAccountDestination = iosAppUrl || iosAppStoreUrl;

    const resetTurnstile = () => {
        const widgetId = turnstileWidgetId.current;
        if (!widgetId || !window.turnstile) return;
        try {
            window.turnstile.reset(widgetId);
        } catch {
            // The widget may already have been removed during a mode change or
            // React cleanup. A stale widget must never break authentication.
            turnstileWidgetId.current = null;
        }
        setTurnstileToken(null);
    };

    const selectMode = (nextMode: 'login' | 'register' | 'import') => {
        const widgetId = turnstileWidgetId.current;
        if (widgetId && window.turnstile) {
            try {
                window.turnstile.remove(widgetId);
            } catch {
                // The widget may already have removed itself.
            }
        }
        turnstileWidgetId.current = null;
        setTurnstileToken(null);
        setTurnstileRequired(false);
        setTurnstileError('');
        setError('');
        setMode(nextMode);
    };

    const { login } = useAuth();

    const [importFile, setImportFile] = useState<File | null>(null);
    const [importPassword, setImportPassword] = useState('');
    const [importEmail, setImportEmail] = useState('');
    const [importHandle, setImportHandle] = useState('');
    const [acceptedCompliance, setAcceptedCompliance] = useState(false);
    const [importAgeVerified, setImportAgeVerified] = useState(false);
    const [importSuccess, setImportSuccess] = useState<string | null>(null);
    const [importWarnings, setImportWarnings] = useState<string[]>([]);

    // Fetch node info
    useEffect(() => {
        fetch('/api/node')
            .then(async res => {
                const data = await res.json();
                if (!res.ok || data.classificationKnown === false) {
                    throw new Error('Node configuration unavailable');
                }
                return data;
            })
            .then(data => {
                setNodeInfo({
                    name: data.name || '',
                    description: typeof data.description === 'string' && data.description.trim()
                        ? data.description.trim()
                        : DEFAULT_NODE_DESCRIPTION,
                    logoUrl: data.logoUrl || undefined,
                    isNsfw: data.isNsfw || false,
                    turnstileSiteKey: data.turnstileSiteKey || null,
                });
                // Update page title
                if (data.name && data.name !== 'Synapsis') {
                    document.title = data.name;
                }
                setNodeInfoUnavailable(false);
                setNodeInfoLoaded(true);
            })
            .catch(() => {
                setNodeInfoUnavailable(true);
                setNodeInfoLoaded(true);
            });
    }, []);

    // Load Cloudflare only after the server asks for a challenge. Normal
    // sign-in and registration never load the third-party widget.
    useEffect(() => {
        if (!turnstileRequired || !nodeInfo.turnstileSiteKey) return;

        if (window.turnstile) {
            setTurnstileLoaded(true);
            return;
        }

        const source = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        let script = document.querySelector<HTMLScriptElement>(`script[src="${source}"]`);
        const handleLoad = () => setTurnstileLoaded(true);

        if (!script) {
            script = document.createElement('script');
            script.src = source;
            script.async = true;
            script.defer = true;
            document.head.appendChild(script);
        }
        script.addEventListener('load', handleLoad);

        return () => {
            script?.removeEventListener('load', handleLoad);
        };
    }, [nodeInfo.turnstileSiteKey, turnstileRequired]);

    // Render Turnstile widget when ready
    useEffect(() => {
        if (!turnstileRequired || !turnstileLoaded || !nodeInfo.turnstileSiteKey
            || !turnstileRef.current || mode === 'import') return;

        // Clean up previous widget
        if (turnstileWidgetId.current && window.turnstile) {
            try {
                window.turnstile.remove(turnstileWidgetId.current);
            } catch {
                // Ignore errors
            }
            turnstileWidgetId.current = null;
        }

        // Render new widget
        if (window.turnstile) {
            turnstileWidgetId.current = window.turnstile.render(turnstileRef.current, {
                sitekey: nodeInfo.turnstileSiteKey,
                action: mode === 'register' ? 'register' : 'login',
                retry: 'never',
                callback: (token: string) => {
                    setTurnstileToken(token);
                    setTurnstileError('');
                },
                'error-callback': () => {
                    setTurnstileToken(null);
                    setTurnstileError(
                        'The security check could not run. Retry it, or allow challenges.cloudflare.com in your browser privacy settings.',
                    );
                },
                'expired-callback': () => {
                    setTurnstileToken(null);
                    setTurnstileError('The security check expired. Please retry it.');
                },
            });
        }

        return () => {
            const widgetId = turnstileWidgetId.current;
            if (widgetId && window.turnstile) {
                try {
                    window.turnstile.remove(widgetId);
                } catch {
                    // Ignore errors
                }
                if (turnstileWidgetId.current === widgetId) {
                    turnstileWidgetId.current = null;
                }
            }
        };
    }, [turnstileLoaded, nodeInfo.turnstileSiteKey, mode, turnstileRequired]);

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
        if (!importFile || !importPassword || !importEmail || !importHandle || !acceptedCompliance) {
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
        setImportWarnings([]);

        try {
            const fileContent = await importFile.text();
            const exportData = JSON.parse(fileContent);

            const res = await fetch('/api/account/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    exportData,
                    password: importPassword,
                    destinationEmail: importEmail,
                    newHandle: importHandle,
                    acceptedCompliance,
                    confirmAge: nodeInfo.isNsfw ? importAgeVerified : undefined,
                }),
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || 'Import failed');
            }

            const warnings = Array.isArray(data.warnings)
                ? data.warnings.filter((warning: unknown): warning is string => typeof warning === 'string')
                : [];
            if (data.signedIn) {
                if (!data.user) throw new Error('Import succeeded without an account');
                await login(data.user, importPassword);
                setImportPassword('');
            }
            setImportSuccess(data.message || 'Account imported successfully.');
            setImportWarnings(warnings);
            if (warnings.length === 0) {
                setTimeout(() => {
                    completePostSignInNavigation(router, onSuccess);
                }, 2000);
            }

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

        if (turnstileRequired && !turnstileToken) {
            setError('Please complete the verification challenge');
            return;
        }

        setLoading(true);

        try {
            const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';

            const body = mode === 'login'
                ? {
                    email,
                    password,
                    ...(turnstileToken ? { turnstileToken } : {})
                }
                : {
                    email,
                    password,
                    handle,
                    displayName,
                    confirmAge: nodeInfo.isNsfw ? ageVerified : undefined,
                    ...(turnstileToken ? { turnstileToken } : {})
                };

            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify(body),
            });

            const data = await res.json();

            if (!res.ok) {
                if (data.requiresTurnstile && nodeInfo.turnstileSiteKey) {
                    setTurnstileRequired(true);
                    setTurnstileToken(null);
                    setTurnstileError('');
                    setError(data.error || 'Please complete the security check to continue.');
                    return;
                }
                throw new Error(data.error || 'Authentication failed');
            }

            if (!data.user) throw new Error('Authentication succeeded without an account');

            // This is deliberately awaited before navigation: the password the
            // user just supplied unlocks their signing identity and creates or
            // unlocks encrypted messaging in one pass. It is never persisted.
            await login(data.user, password);

            // Do not navigate on the strength of the login response alone.
            // Confirm the browser retained the server session first so a cookie
            // handoff failure cannot masquerade as a successful sign-in/reload.
            const sessionResponse = await fetch('/api/auth/me', {
                cache: 'no-store',
                credentials: 'same-origin',
            });
            const sessionData = await sessionResponse.json();
            if (!sessionResponse.ok || sessionData.user?.id !== data.user.id) {
                throw new Error('Your sign-in session could not be saved. Please try again.');
            }

            setPassword('');
            setConfirmPassword('');

            // Keep this JavaScript realm alive: login just decrypted the signing
            // key into memory, and App Router navigation preserves it.
            completePostSignInNavigation(
                router,
                onSuccess,
                iosFunnel ? '/continue-in-app' : '/',
            );
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
            if (turnstileRequired) resetTurnstile();
        } finally {
            setLoading(false);
        }
    };

    const content = (
        <div className={`auth-screen-shell${iosFunnel ? ' ios-auth-funnel' : ''}${modal ? ' auth-screen-modal' : ''}`}>
            <div
                className="auth-screen-panel"
                style={{ maxWidth: iosFunnel ? '440px' : mode === 'register' ? '680px' : '400px' }}
            >
                {/* Logo */}
                <div className="auth-screen-header">
                    {nodeInfoLoaded && (
                        <>
                            {nodeInfo.logoUrl ? (
                                <Image
                                    src={nodeInfo.logoUrl}
                                    alt={nodeInfo.name || 'Node logo'}
                                    width={200}
                                    height={60}
                                    className="auth-node-logo"
                                    style={{ objectFit: 'contain', maxHeight: '60px', width: 'auto' }}
                                    unoptimized
                                />
                            ) : (
                                <Image
                                    src="/logotext.svg"
                                    alt="Synapsis"
                                    width={200}
                                    height={48}
                                    className="auth-node-logo"
                                    style={{ objectFit: 'contain' }}
                                    priority
                                />
                            )}
                            {iosFunnel ? (
                                <>
                                    <div className="auth-ios-eyebrow">iPhone account setup</div>
                                    <h1>Create your account</h1>
                                    <p>
                                        {`Join ${nodeInfo.name || 'this node'} here, then continue in the Synapsis app.`}
                                    </p>
                                    <a
                                        className="btn btn-primary auth-ios-app-store"
                                        href={iosAppStoreUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        <Download size={18} />
                                        <span>Download Synapsis for iPhone</span>
                                        <ArrowUpRight size={15} />
                                    </a>
                                </>
                            ) : (
                                <>
                                    {nodeInfo.name && nodeInfo.name !== 'Synapsis' && !nodeInfo.logoUrl && (
                                        <div className="auth-node-name">
                                            {nodeInfo.name}
                                        </div>
                                    )}
                                    <p>{nodeInfo.description}</p>
                                </>
                            )}
                            {nodeInfoUnavailable && (
                                <p role="status" className="auth-node-warning">
                                    Node details are temporarily unavailable.
                                </p>
                            )}
                        </>
                    )}
                </div>

                {/* Mode Switcher */}
                {!iosFunnel && (
                    <div className="auth-mode-switcher">
                        <button
                            type="button"
                            onClick={() => selectMode('login')}
                            className={mode === 'login' ? 'active' : ''}
                        >
                            Login
                        </button>
                        <button
                            type="button"
                            onClick={() => selectMode('register')}
                            className={mode === 'register' ? 'active' : ''}
                        >
                            Register
                        </button>
                        <button
                            type="button"
                            onClick={() => selectMode('import')}
                            className={mode === 'import' ? 'active' : ''}
                        >
                            Import
                        </button>
                    </div>
                )}

                {/* Form */}
                {mode !== 'import' ? (
                    <form onSubmit={handleSubmit} className="card auth-card">
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
                            <div className="auth-register-fields">
                                <div className="auth-field-handle">
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
                                            name="username"
                                            autoComplete="username"
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
                                <div className="auth-field-password">
                                    <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>
                                        Password
                                    </label>
                                    <input
                                        type="password"
                                        name="password"
                                        autoComplete="new-password"
                                        className="input"
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        placeholder="••••••••"
                                        required
                                        minLength={8}
                                    />
                                </div>
                                <div className="auth-field-display-name">
                                    <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>
                                        Display Name
                                    </label>
                                    <input
                                        type="text"
                                        name="displayName"
                                        autoComplete="nickname"
                                        className="input"
                                        value={displayName}
                                        onChange={(e) => setDisplayName(e.target.value)}
                                        placeholder="Your Name"
                                    />
                                </div>
                                <div className="auth-field-confirm-password">
                                    <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>
                                        Confirm Password
                                    </label>
                                    <input
                                        type="password"
                                        name="confirmPassword"
                                        autoComplete="new-password"
                                        className="input"
                                        value={confirmPassword}
                                        onChange={(e) => setConfirmPassword(e.target.value)}
                                        placeholder="••••••••"
                                        required
                                        minLength={8}
                                    />
                                </div>
                                <div className="auth-field-email">
                                    <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px', fontWeight: 500 }}>
                                        Email
                                    </label>
                                    <input
                                        type="email"
                                        name="email"
                                        autoComplete="email"
                                        className="input"
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        placeholder="you@example.com"
                                        required
                                    />
                                </div>
                            </div>
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
                            <div className="auth-age-confirmation">
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

                        {turnstileRequired && nodeInfo.turnstileSiteKey && (
                            <div style={{ marginBottom: '20px', textAlign: 'center' }}>
                                <div style={{ display: 'flex', justifyContent: 'center' }}>
                                    <div ref={turnstileRef}></div>
                                </div>
                                {turnstileError && (
                                    <div style={{ marginTop: '10px', fontSize: '13px', color: 'var(--error)' }}>
                                        <div>{turnstileError}</div>
                                        <button
                                            type="button"
                                            className="btn btn-secondary"
                                            style={{ marginTop: '8px', padding: '6px 12px' }}
                                            onClick={() => {
                                                setTurnstileError('');
                                                resetTurnstile();
                                            }}
                                        >
                                            Retry verification
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        <button
                            type="submit"
                            className="btn btn-primary btn-lg auth-submit"
                            style={{ width: '100%' }}
                            disabled={loading || 
                                (turnstileRequired && !turnstileToken) ||
                                (mode === 'register' && (
                                    !handle || handle.length < 3 ||
                                    !email ||
                                    !password || password.length < 8 ||
                                    !confirmPassword ||
                                    password !== confirmPassword ||
                                    (nodeInfo.isNsfw && !ageVerified)
                                ))}
                        >
                            {loading
                                ? 'Please wait...'
                                : mode === 'login'
                                    ? iosFunnel ? 'Sign in and continue' : 'Login'
                                    : iosFunnel ? 'Create account and continue' : 'Create Account'}
                        </button>
                    </form>
                ) : (
                    <form onSubmit={handleImport} className="card auth-card">
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
                                <div>{importSuccess}</div>
                                {importWarnings.length > 0 ? (
                                    <>
                                        <ul style={{ margin: '8px 0 10px', paddingLeft: 20 }}>
                                            {importWarnings.map((warning) => <li key={warning}>{warning}</li>)}
                                        </ul>
                                        <button
                                            type="button"
                                            className="btn"
                                            onClick={() => {
                                                completePostSignInNavigation(router, onSuccess);
                                            }}
                                            style={{ width: '100%', justifyContent: 'center' }}
                                        >
                                            Continue
                                        </button>
                                    </>
                                ) : ' Redirecting…'}
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
                                Email on this node
                            </label>
                            <input
                                type="email"
                                className="input"
                                value={importEmail}
                                onChange={(e) => setImportEmail(e.target.value)}
                                placeholder="you@example.com"
                                autoComplete="email"
                                required
                                maxLength={320}
                            />
                            <span style={{ display: 'block', color: 'var(--foreground-tertiary)', fontSize: '12px', marginTop: '4px' }}>
                                You&apos;ll use this email to sign in after the import.
                            </span>
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
                                    </strong> I agree to comply with this node&apos;s rules and take responsibility for my migrated content.
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
                            disabled={loading || !importFile || !importPassword || !importEmail || !importHandle || !acceptedCompliance || (nodeInfo.isNsfw && !importAgeVerified)}
                        >
                            {loading ? 'Importing...' : 'Import Account'}
                        </button>
                    </form>
                )}

                {!modal && (iosFunnel ? (
                    <div className="auth-ios-footnote">
                        <strong>Already have an account?</strong>{' '}
                        {existingAccountDestination ? (
                            <a
                                href={existingAccountDestination}
                                target={iosAppUrl ? undefined : '_blank'}
                                rel={iosAppUrl ? undefined : 'noreferrer'}
                            >
                                {iosAppUrl ? 'Open Synapsis' : 'Download Synapsis for iPhone'}
                            </a>
                        ) : (
                            'Sign in inside the Synapsis app.'
                        )}{' '}
                        This website is only for creating an account on iPhone.
                    </div>
                ) : (
                    <p className="auth-back-link">
                        <Link href="/">← Back to home</Link>
                    </p>
                ))}
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
        <div className="auth-page">
            {content}
        </div>
    );
}
