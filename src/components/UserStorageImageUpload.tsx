'use client';

import { useRef, useState } from 'react';
import { StorageSessionPrompt } from '@/components/StorageSessionPrompt';
import { StorageConfigurationPrompt } from '@/components/StorageConfigurationPrompt';
import { refreshStorageSession } from '@/lib/storage/client';
import { MediaUploadError, uploadMediaFile } from '@/lib/stuffbox/browser-upload';

interface UserStorageImageUploadProps {
    label: string;
    value: string;
    onChange: (url: string) => void;
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
    helperText,
    previewWidth = 48,
    previewHeight = 48,
    previewBorderRadius = '8px',
    onError,
}: UserStorageImageUploadProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [isUploading, setIsUploading] = useState(false);
    const [showSessionPrompt, setShowSessionPrompt] = useState(false);
    const [showConfigurationPrompt, setShowConfigurationPrompt] = useState(false);
    const [pendingFile, setPendingFile] = useState<File | null>(null);
    const [password, setPassword] = useState('');
    const [promptError, setPromptError] = useState('');
    const [isRefreshingSession, setIsRefreshingSession] = useState(false);

    const resetFileInput = () => {
        if (inputRef.current) {
            inputRef.current.value = '';
        }
    };

    const uploadFile = async (file: File, allowPrompt = true) => {
        setIsUploading(true);

        try {
            const media = await uploadMediaFile(file);

            onChange(media.url);
            onError?.('');
            setPendingFile(null);
            setShowSessionPrompt(false);
            setPassword('');
            setPromptError('');
        } catch (error) {
            if (error instanceof MediaUploadError && error.code === 'STORAGE_NOT_CONFIGURED' && allowPrompt) {
                setPendingFile(file);
                setShowConfigurationPrompt(true);
                return;
            }
            if (error instanceof MediaUploadError && error.status === 401 && allowPrompt) {
                setPendingFile(file);
                setPromptError('');
                setShowSessionPrompt(true);
                return;
            }
            onError?.(error instanceof Error ? error.message : 'Upload failed');
        } finally {
            setIsUploading(false);
            resetFileInput();
        }
    };

    const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        await uploadFile(file);
    };

    const handlePromptSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!pendingFile) {
            setShowSessionPrompt(false);
            return;
        }

        if (!password.trim()) {
            setPromptError('Please enter your password');
            return;
        }

        setIsRefreshingSession(true);
        setPromptError('');

        try {
            await refreshStorageSession(password.trim());
            await uploadFile(pendingFile, false);
        } catch (error) {
            setPromptError(error instanceof Error ? error.message : 'Failed to confirm password');
        } finally {
            setIsRefreshingSession(false);
        }
    };

    const handlePromptCancel = () => {
        setShowSessionPrompt(false);
        setPendingFile(null);
        setPassword('');
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

            <StorageSessionPrompt
                open={showSessionPrompt}
                isSubmitting={isRefreshingSession}
                password={password}
                error={promptError}
                onPasswordChange={(nextPassword) => {
                    setPassword(nextPassword);
                    setPromptError('');
                }}
                onSubmit={handlePromptSubmit}
                onCancel={handlePromptCancel}
            />
            <StorageConfigurationPrompt
                open={showConfigurationPrompt}
                onConfigured={async () => {
                    setShowConfigurationPrompt(false);
                    if (pendingFile) await uploadFile(pendingFile, false);
                }}
                onCancel={() => {
                    setShowConfigurationPrompt(false);
                    setPendingFile(null);
                    resetFileInput();
                }}
            />
        </>
    );
}
