'use client';

import { useRef, useState } from 'react';

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

    const resetFileInput = () => {
        if (inputRef.current) {
            inputRef.current.value = '';
        }
    };

    const uploadFile = async (file: File) => {
        setIsUploading(true);

        try {
            const formData = new FormData();
            formData.append('file', file);

            const res = await fetch('/api/media/upload', {
                method: 'POST',
                body: formData,
            });
            const data = await res.json();

            if (!res.ok || !data.url) {
                const message = data.error || 'Upload failed';

                if (res.status === 401) {
                    throw new Error(message || 'Upload session expired. Please sign in again.');
                }

                throw new Error(message);
            }

            onChange(data.media?.url || data.url);
            onError?.('');
        } catch (error) {
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

    return (
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

            <p
                style={{
                    fontSize: '12px',
                    color: 'var(--foreground-tertiary)',
                    marginTop: '6px',
                }}
            >
                If uploads stop working after a long session, sign in again to refresh your upload access.
            </p>
        </div>
    );
}
