'use client';

interface StorageSessionPromptProps {
    open: boolean;
    isSubmitting: boolean;
    password: string;
    error: string;
    title?: string;
    description?: string;
    onPasswordChange: (password: string) => void;
    onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
    onCancel: () => void;
}

export function StorageSessionPrompt({
    open,
    isSubmitting,
    password,
    error,
    title = 'Confirm your password',
    description = 'Please confirm your password to continue uploading to your storage.',
    onPasswordChange,
    onSubmit,
    onCancel,
}: StorageSessionPromptProps) {
    if (!open) {
        return null;
    }

    return (
        <div
            style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0, 0, 0, 0.8)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 99999,
                padding: '20px',
            }}
            onClick={onCancel}
        >
            <div
                className="card"
                style={{ width: '100%', maxWidth: '420px', padding: '20px' }}
                onClick={(event) => event.stopPropagation()}
            >
                <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>
                    {title}
                </h3>
                <p style={{ color: 'var(--foreground-secondary)', marginBottom: '16px', lineHeight: 1.5 }}>
                    {description}
                </p>

                <form onSubmit={onSubmit}>
                    <div style={{ marginBottom: '12px' }}>
                        <label
                            htmlFor="storage-session-password"
                            style={{
                                display: 'block',
                                marginBottom: '8px',
                                fontSize: '14px',
                                fontWeight: 500,
                            }}
                        >
                            Password
                        </label>
                        <input
                            id="storage-session-password"
                            type="password"
                            className="input"
                            value={password}
                            onChange={(event) => onPasswordChange(event.target.value)}
                            autoFocus
                        />
                    </div>

                    {error && (
                        <div style={{ color: 'var(--error)', fontSize: '13px', marginBottom: '12px' }}>
                            {error}
                        </div>
                    )}

                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={isSubmitting}>
                            Cancel
                        </button>
                        <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
                            {isSubmitting ? 'Confirming...' : 'Continue'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
