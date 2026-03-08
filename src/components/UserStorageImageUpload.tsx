'use client';

import { useEffect, useRef, useState } from 'react';

interface UserStorageImageUploadProps {
    label: string;
    value: string;
    onChange: (url: string) => void;
    password: string;
    onPasswordChange: (password: string) => void;
    helperText?: string;
    previewWidth?: number;
    previewHeight?: number;
    previewBorderRadius?: string;
    onError?: (message: string) => void;
}

export function UserStorageImageUpload({
    label,
    value,
    onChange,
    password,
    onPasswordChange,
    helperText,
    previewWidth = 48,
    previewHeight = 48,
    previewBorderRadius = '8px',
    onError,
}: UserStorageImageUploadProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [isUploading, setIsUploading] = useState(false);
    const [showPasswordPrompt, setShowPasswordPrompt] = useState(false);
    const [pendingFile, setPendingFile] = useState<File | null>(null);
    const [passwordInput, setPasswordInput] = useState(password);
    const [promptError, setPromptError] = useState('');

    useEffect(() => {
        if (!showPasswordPrompt) {
            setPromptError('');
        }
    }, [showPasswordPrompt]);

    useEffect(() => {
        if (showPasswordPrompt && !passwordInput && password) {
            setPasswordInput(password);
        }
    }, [showPasswordPrompt, password, passwordInput]);

    const reportError = (message: string) => {
        setPromptError(message);
        onError?.(message);
    };

    const resetFileInput = () => {
        if (inputRef.current) {
            inputRef.current.value = '';
        }
    };

    const uploadFile = async (file: File, uploadPassword: string) => {
        setIsUploading(true);
        setPromptError('');

        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('password', uploadPassword);

            const res = await fetch('/api/media/upload', {
                method: 'POST',
                body: formData,
            });
            const data = await res.json();

            if (!res.ok || !data.url) {
                const message = data.error || 'Upload failed';

                if (res.status === 401) {
                    onPasswordChange('');
                    setPasswordInput('');
                    setPendingFile(file);
                    setShowPasswordPrompt(true);
                    setPromptError(message);
                    return;
                }

                throw new Error(message);
            }

            onPasswordChange(uploadPassword);
            onChange(data.media?.url || data.url);
            onError?.('');
            setPendingFile(null);
            setShowPasswordPrompt(false);
            setPasswordInput(uploadPassword);
        } catch (error) {
            reportError(error instanceof Error ? error.message : 'Upload failed');
        } finally {
            setIsUploading(false);
            resetFileInput();
        }
    };

    const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        setPendingFile(file);

        if (password.trim()) {
            await uploadFile(file, password.trim());
            return;
        }

        setPasswordInput('');
        setShowPasswordPrompt(true);
    };

    const handlePasswordSubmit = async (event: React.FormEvent) => {
        event.preventDefault();

        if (!pendingFile) {
            setShowPasswordPrompt(false);
            return;
        }

        if (!passwordInput.trim()) {
            setPromptError('Please enter your password');
            return;
        }

        await uploadFile(pendingFile, passwordInput.trim());
    };

    const handleCancel = () => {
        setShowPasswordPrompt(false);
        setPendingFile(null);
        setPasswordInput(password);
        setPromptError('');
        resetFileInput();
    };

    return (
        <>
            <div>
                <label style={{ display: 'block', fontSize: '14px', fontWeight: 500, marginBottom: '8px' }}>
                    {label}
                </label>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <label className="btn btn-ghost btn-sm" style={{ cursor: isUploading ? 'default' : 'pointer' }}>
                        {isUploading ? 'Uploading...' : 'Choose File'}
                        <input
                            ref={inputRef}
                            type="file"
                            accept="image/*"
                            onChange={handleFileChange}
                            disabled={isUploading}
                            style={{ display: 'none' }}
                        />
                    </label>

                    {value && (
                        <div
                            style={{
                                width: `${previewWidth}px`,
                                height: `${previewHeight}px`,
                                borderRadius: previewBorderRadius,
                                overflow: 'hidden',
                                border: '1px solid var(--border)',
                                background: 'var(--background-tertiary)',
                            }}
                        >
                            <img
                                src={value}
                                alt={`${label} preview`}
                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                            />
                        </div>
                    )}

                    {value && (
                        <button
                            type="button"
                            onClick={() => onChange('')}
                            className="btn btn-ghost btn-sm"
                            style={{ color: 'var(--error)' }}
                        >
                            Remove
                        </button>
                    )}
                </div>

                {helperText && (
                    <p style={{ fontSize: '13px', color: 'var(--foreground-tertiary)', marginTop: '6px' }}>
                        {helperText}
                    </p>
                )}
            </div>

            {showPasswordPrompt && (
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
                    onClick={handleCancel}
                >
                    <div
                        className="card"
                        style={{ width: '100%', maxWidth: '420px', padding: '20px' }}
                        onClick={(event) => event.stopPropagation()}
                    >
                        <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>
                            Unlock storage upload
                        </h3>
                        <p style={{ color: 'var(--foreground-secondary)', marginBottom: '16px', lineHeight: 1.5 }}>
                            Enter your account password to upload this image to your own storage.
                        </p>

                        <form onSubmit={handlePasswordSubmit}>
                            <div style={{ marginBottom: '12px' }}>
                                <label
                                    htmlFor="storage-upload-password"
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
                                    id="storage-upload-password"
                                    type="password"
                                    className="input"
                                    value={passwordInput}
                                    onChange={(event) => {
                                        setPasswordInput(event.target.value);
                                        setPromptError('');
                                    }}
                                    autoFocus
                                />
                            </div>

                            {promptError && (
                                <div style={{ color: 'var(--error)', fontSize: '13px', marginBottom: '12px' }}>
                                    {promptError}
                                </div>
                            )}

                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                                <button type="button" className="btn btn-ghost" onClick={handleCancel} disabled={isUploading}>
                                    Cancel
                                </button>
                                <button type="submit" className="btn btn-primary" disabled={isUploading}>
                                    {isUploading ? 'Uploading...' : 'Upload'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </>
    );
}
