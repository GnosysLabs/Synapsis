'use client';

import { useState } from 'react';
import { Lock, Loader2, AlertCircle } from 'lucide-react';
import { useAuth } from '@/lib/contexts/AuthContext';

interface IdentityUnlockPromptProps {
    onUnlock?: () => void;
    onCancel?: () => void;
}

/**
 * IdentityUnlockPrompt Modal Component
 * 
 * Prompts the user to unlock their cryptographic identity by entering their password.
 * This is required when the user's private key is not available in memory (e.g., after
 * page refresh or when the session expires).
 * 
 * Requirements: US-2.3, US-5.1
 */
export function IdentityUnlockPrompt({ onUnlock, onCancel }: IdentityUnlockPromptProps) {
    const { unlockIdentity } = useAuth();
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [isUnlocking, setIsUnlocking] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!password.trim()) {
            setError('Please enter your password');
            return;
        }

        setError(null);
        setIsUnlocking(true);

        try {
            await unlockIdentity(password);

            // Success! Call the onUnlock callback if provided
            if (onUnlock) {
                onUnlock();
            }
        } catch (err) {
            console.error('[IdentityUnlockPrompt] Failed to unlock identity:', err);
            setError(err instanceof Error ? err.message : 'Your identity could not be unlocked. Please try again.');
        } finally {
            setIsUnlocking(false);
        }
    };

    const handleCancel = () => {
        setPassword('');
        setError(null);
        if (onCancel) {
            onCancel();
        }
    };

    return (
        <>
            <style jsx>{`
                @keyframes slideUp {
                    from {
                        transform: translateY(100%);
                    }
                    to {
                        transform: translateY(0);
                    }
                }

                .identity-unlock-container {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0.8);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 99999;
                    padding: 20px;
                }

                .identity-unlock-sheet {
                    width: 100%;
                    max-width: 400px;
                    background: var(--background-secondary);
                    border-radius: 12px;
                    padding: 24px;
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
                }

                .drag-indicator {
                    display: none;
                }

                @media (max-width: 768px) {
                    .identity-unlock-container {
                        align-items: flex-end;
                        padding: 0;
                    }

                    .identity-unlock-sheet {
                        max-width: 100%;
                        border-radius: 0;
                        border-top-left-radius: 20px;
                        border-top-right-radius: 20px;
                        padding: 24px;
                        padding-bottom: calc(24px + env(safe-area-inset-bottom));
                        animation: slideUp 0.3s ease-out;
                    }

                    .drag-indicator {
                        display: block;
                        width: 40px;
                        height: 4px;
                        background: var(--border);
                        border-radius: 2px;
                        margin: 0 auto 20px;
                    }
                }
            `}</style>

            <div
                className="identity-unlock-container"
                onClick={handleCancel}
            >
                <div
                    className="identity-unlock-sheet"
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Drag indicator - only visible on mobile */}
                    <div className="drag-indicator" />

                    {/* Header */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                        <div style={{
                            width: '48px',
                            height: '48px',
                            borderRadius: '50%',
                            background: 'rgba(255, 255, 255, 0.1)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                        }}>
                            <Lock size={24} style={{ color: 'var(--accent)' }} />
                        </div>
                        <h2 style={{ fontSize: '20px', fontWeight: 600, margin: 0 }}>
                            Identity Required
                        </h2>
                    </div>

                    {/* Description */}
                    <p style={{ color: 'var(--foreground-secondary)', marginBottom: '20px', lineHeight: 1.5, fontSize: '15px' }}>
                        Enter your password to unlock your identity
                    </p>

                    {/* Form */}
                    <form onSubmit={handleSubmit}>
                        <div style={{ marginBottom: '16px' }}>
                            <label
                                htmlFor="unlock-password"
                                style={{
                                    display: 'block',
                                    marginBottom: '8px',
                                    fontSize: '14px',
                                    fontWeight: 500,
                                    color: 'var(--foreground)'
                                }}
                            >
                                Password
                            </label>
                            <input
                                id="unlock-password"
                                type="password"
                                value={password}
                                onChange={(e) => {
                                    setPassword(e.target.value);
                                    setError(null);
                                }}
                                disabled={isUnlocking}
                                placeholder="Enter your password"
                                autoFocus
                                style={{
                                    width: '100%',
                                    padding: '12px 14px',
                                    borderRadius: '8px',
                                    border: error ? '2px solid var(--error)' : '1px solid var(--border)',
                                    background: 'var(--background)',
                                    color: 'var(--foreground)',
                                    fontSize: '15px',
                                    outline: 'none',
                                    transition: 'border-color 0.2s'
                                }}
                                onFocus={(e) => {
                                    if (!error) {
                                        e.target.style.borderColor = 'var(--accent)';
                                    }
                                }}
                                onBlur={(e) => {
                                    if (!error) {
                                        e.target.style.borderColor = 'var(--border)';
                                    }
                                }}
                            />
                        </div>

                        {/* Error Message */}
                        {error && (
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                padding: '12px 14px',
                                borderRadius: '8px',
                                background: 'rgba(239, 68, 68, 0.1)',
                                color: 'var(--error)',
                                fontSize: '14px',
                                marginBottom: '16px'
                            }}>
                                <AlertCircle size={18} />
                                <span>{error}</span>
                            </div>
                        )}

                        {/* Buttons */}
                        <div style={{ display: 'flex', gap: '12px', marginTop: '20px' }}>
                            <button
                                type="button"
                                onClick={handleCancel}
                                disabled={isUnlocking}
                                className="btn btn-ghost"
                                style={{ 
                                    flex: 1,
                                    minHeight: '44px',
                                    padding: '10px 16px',
                                    fontSize: '15px'
                                }}
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                disabled={isUnlocking || !password.trim()}
                                className="btn btn-primary"
                                style={{
                                    flex: 1,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: '8px',
                                    minHeight: '44px',
                                    padding: '10px 16px',
                                    fontSize: '15px'
                                }}
                            >
                                {isUnlocking ? (
                                    <>
                                        <Loader2 size={18} className="animate-spin" />
                                        <span>Unlocking...</span>
                                    </>
                                ) : (
                                    <>
                                        <Lock size={16} />
                                        <span>Unlock</span>
                                    </>
                                )}
                            </button>
                        </div>
                    </form>

                    {/* Info Note */}
                    <p style={{
                        fontSize: '13px',
                        color: 'var(--foreground-tertiary)',
                        marginTop: '16px',
                        marginBottom: 0,
                        lineHeight: 1.5,
                        textAlign: 'center'
                    }}>
                        Your password never leaves this device
                    </p>
                </div>
            </div>
        </>
    );
}
