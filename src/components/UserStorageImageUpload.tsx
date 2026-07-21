'use client';

import { useRef, useState, type ReactNode } from 'react';
import Image from 'next/image';
import { StorageConfigurationPrompt } from '@/components/StorageConfigurationPrompt';
import { getStorageProvider, MediaUploadError, uploadMediaFile } from '@/lib/stuffbox/browser-upload';

interface UserStorageImageUploadProps {
    label: string;
    value: string;
    onChange: (url: string) => void;
    helperText?: string;
    previewWidth?: number;
    previewHeight?: number;
    previewBorderRadius?: string;
    onError?: (message: string) => void;
    renderTrigger?: (controls: {
        chooseFile: () => void;
        isUploading: boolean;
    }) => ReactNode;
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
    renderTrigger,
}: UserStorageImageUploadProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const storageCheckInFlightRef = useRef(false);
    const [isUploading, setIsUploading] = useState(false);
    const [storageNotice, setStorageNotice] = useState('');
    const [showConfigurationPrompt, setShowConfigurationPrompt] = useState(false);
    const [pendingFile, setPendingFile] = useState<File | null>(null);

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
        } catch (error) {
            if (error instanceof MediaUploadError && error.code === 'STORAGE_NOT_CONFIGURED' && allowPrompt) {
                setPendingFile(file);
                setShowConfigurationPrompt(true);
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

    const handleChooseFile = async () => {
        if (storageCheckInFlightRef.current) return;
        storageCheckInFlightRef.current = true;
        setStorageNotice('');
        onError?.('');
        try {
            if (!await getStorageProvider()) {
                setShowConfigurationPrompt(true);
                return;
            }
            inputRef.current?.click();
        } catch (error) {
            onError?.(error instanceof Error ? error.message : 'Unable to check media storage');
        } finally {
            storageCheckInFlightRef.current = false;
        }
    };

    return (
        <>
            {renderTrigger ? renderTrigger({ chooseFile: handleChooseFile, isUploading }) : (
                <div>
                    <label style={{ display: 'block', fontSize: '14px', fontWeight: 500, marginBottom: '8px' }}>
                        {label}
                    </label>
                    <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                        <button className="btn btn-ghost btn-sm" type="button" onClick={handleChooseFile} disabled={isUploading}>
                            {isUploading ? 'Uploading...' : 'Choose File'}
                        </button>

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
                                <Image
                                    unoptimized
                                    src={value}
                                    alt={`${label} preview`}
                                    width={previewWidth}
                                    height={previewHeight}
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
                    {storageNotice && (
                        <p style={{ fontSize: '13px', color: 'var(--success)', marginTop: '6px' }}>
                            {storageNotice}
                        </p>
                    )}
                </div>
            )}

            <input
                ref={inputRef}
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                disabled={isUploading}
                style={{ display: 'none' }}
            />

            <StorageConfigurationPrompt
                open={showConfigurationPrompt}
                onConfigured={async () => {
                    setShowConfigurationPrompt(false);
                    if (pendingFile) {
                        await uploadFile(pendingFile, false);
                        return;
                    }
                    setStorageNotice('Stuffbox connected. Choose your file to continue.');
                    inputRef.current?.click();
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
