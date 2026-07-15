'use client';

import { useState, useEffect, useRef } from 'react';
import AutoTextarea from '@/components/AutoTextarea';
import { Post, Attachment } from '@/lib/types';
import { AlertTriangle, Music2, Paperclip } from 'lucide-react';
import { VideoEmbed } from '@/components/VideoEmbed';
import { useFormattedHandle } from '@/lib/utils/handle';
import { useAuth } from '@/lib/contexts/AuthContext';
import { StorageConfigurationPrompt } from '@/components/StorageConfigurationPrompt';
import { getStorageProvider, MediaUploadError, uploadMediaFile } from '@/lib/stuffbox/browser-upload';
import { getMediaKind } from '@/lib/media/upload-policy';

interface MediaAttachment extends Attachment {
    mimeType?: string;
    filename?: string;
}

interface ComposeProps {
    onPost: (content: string, mediaIds: string[], linkPreview?: any, replyToId?: string, isNsfw?: boolean) => void | boolean | Promise<void | boolean>;
    onPosted?: () => void;
    replyingTo?: Post | null;
    onCancelReply?: () => void;
    placeholder?: string;
    isReply?: boolean;
    autoFocus?: boolean;
}

export function Compose({ onPost, onPosted, replyingTo, onCancelReply, placeholder = "What's happening?", isReply, autoFocus = false }: ComposeProps) {
    const { isIdentityUnlocked } = useAuth();
    const replyToHandle = replyingTo ? useFormattedHandle(replyingTo.author.handle) : '';
    const [content, setContent] = useState('');
    const [isPosting, setIsPosting] = useState(false);
    const [attachments, setAttachments] = useState<MediaAttachment[]>([]);
    const [isUploading, setIsUploading] = useState(false);
    const [isCheckingStorage, setIsCheckingStorage] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [storageNotice, setStorageNotice] = useState<string | null>(null);
    const [pendingStorageFiles, setPendingStorageFiles] = useState<File[]>([]);
    const [showStorageConfiguration, setShowStorageConfiguration] = useState(false);
    const [linkPreview, setLinkPreview] = useState<any>(null);
    const [fetchingPreview, setFetchingPreview] = useState(false);
    const [lastDetectedUrl, setLastDetectedUrl] = useState<string | null>(null);
    const [isNsfw, setIsNsfw] = useState(false);
    const [canPostNsfw, setCanPostNsfw] = useState(false);
    const [isNsfwNode, setIsNsfwNode] = useState(false);
    const mediaInputRef = useRef<HTMLInputElement>(null);
    const maxLength = 600;
    const remaining = maxLength - content.length;
    const canSubmit = content.trim().length > 0 || attachments.length > 0;
    const previewMedia = linkPreview?.media?.length
        ? linkPreview.media
        : linkPreview?.image
            ? [{ url: linkPreview.image }]
            : [];
    const previewImage = previewMedia[0]?.url || linkPreview?.image || null;
    const isEmbeddedVideo = Boolean(linkPreview?.url?.match(/(youtube\.com|youtu\.be|vimeo\.com)/));

    // Check if user can post NSFW content and if node is NSFW
    useEffect(() => {
        fetch('/api/settings/nsfw')
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                if (data?.nsfwEnabled) {
                    setCanPostNsfw(true);
                }
            })
            .catch(() => { });

        fetch('/api/node')
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                if (data?.isNsfw) {
                    setIsNsfwNode(true);
                }
            })
            .catch(() => { });
    }, []);

    // Detect URLs in content
    useEffect(() => {
        const urlRegex = /(?:https?:\/\/)?((?:[a-zA-Z0-9-]+\.)+[a-z]{2,63})\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/gi;
        const matches = content.match(urlRegex);

        if (matches && matches[0]) {
            const url = matches[0];
            if (url !== lastDetectedUrl) {
                setLastDetectedUrl(url);
                fetchPreview(url);
            }
        } else if (!content.trim()) {
            setLinkPreview(null);
            setLastDetectedUrl(null);
        }
    }, [content, lastDetectedUrl]);

    const fetchPreview = async (url: string) => {
        setFetchingPreview(true);
        try {
            const res = await fetch(`/api/media/preview?url=${encodeURIComponent(url)}`);
            if (res.ok) {
                const data = await res.json();
                setLinkPreview(data);
            }
        } catch (err) {
            console.error('Preview error', err);
        } finally {
            setFetchingPreview(false);
        }
    };

    const handleSubmit = async () => {
        if (!canSubmit || isPosting || isUploading) return;

        // With persistence, identity should be unlocked. If not, user needs to re-login
        if (!isIdentityUnlocked) {
            alert('Your session has expired. Please log in again.');
            return;
        }

        setIsPosting(true);
        try {
            const posted = await onPost(content, attachments.map((item) => item.id).filter(Boolean), linkPreview, replyingTo?.id, isNsfw);
            if (posted === false) {
                setIsPosting(false);
                return;
            }

            setContent('');
            setAttachments([]);
            setLinkPreview(null);
            setLastDetectedUrl(null);
            setIsNsfw(false);
            setIsPosting(false);
            onPosted?.();
        } catch (error) {
            setIsPosting(false);
            throw error;
        }
    };

    const uploadMediaFiles = async (files: File[]) => {
        const remainingSlots = Math.max(0, 4 - attachments.length);
        const selectedFiles = files.slice(0, remainingSlots);
        if (selectedFiles.length === 0) return;

        setUploadError(null);
        setIsUploading(true);

        const uploaded: MediaAttachment[] = [];

        for (const file of selectedFiles) {
            try {
                const media = await uploadMediaFile(file);

                uploaded.push({
                    id: media.id,
                    url: media.url,
                    altText: media.altText ?? null,
                    mimeType: media.mimeType ?? file.type,
                    filename: file.name,
                });
            } catch (error) {
                if (error instanceof MediaUploadError && error.code === 'STORAGE_NOT_CONFIGURED') {
                    setAttachments((prev) => [...prev, ...uploaded].slice(0, 4));
                    setPendingStorageFiles(selectedFiles.slice(uploaded.length));
                    setShowStorageConfiguration(true);
                    setIsUploading(false);
                    return;
                }
                console.error('Upload failed', error);
                setUploadError('One or more uploads failed. Try again.');
            }
        }

        setAttachments((prev) => [...prev, ...uploaded].slice(0, 4));
        setIsUploading(false);
    };

    const handleMediaSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files || []);
        event.target.value = '';
        if (files.length === 0) return;
        await uploadMediaFiles(files);
    };

    const handleAddMedia = async () => {
        setUploadError(null);
        setStorageNotice(null);
        setIsCheckingStorage(true);
        try {
            const provider = await getStorageProvider();
            if (!provider) {
                setShowStorageConfiguration(true);
                return;
            }
            mediaInputRef.current?.click();
        } catch (error) {
            setUploadError(error instanceof Error ? error.message : 'Unable to check media storage');
        } finally {
            setIsCheckingStorage(false);
        }
    };

    const handleRemoveAttachment = (id: string) => {
        setAttachments((prev) => prev.filter((item) => item.id !== id));
    };

    return (
        <div className={`compose ${isReply ? 'reply-compose' : ''}`}>
            <StorageConfigurationPrompt
                open={showStorageConfiguration}
                onConfigured={async () => {
                    setShowStorageConfiguration(false);
                    const files = pendingStorageFiles;
                    setPendingStorageFiles([]);
                    if (files.length > 0) {
                        await uploadMediaFiles(files);
                        return;
                    }
                    setStorageNotice('Stuffbox connected. Choose your media to continue.');
                    mediaInputRef.current?.click();
                }}
                onCancel={() => {
                    setShowStorageConfiguration(false);
                    setPendingStorageFiles([]);
                }}
            />
            {replyingTo && !isReply && (
                <div className="compose-reply-target">
                    <div className="compose-reply-info">
                        Replying to <span className="compose-reply-handle">{replyToHandle}</span>
                    </div>
                    <button type="button" className="compose-reply-cancel" onClick={onCancelReply}>
                        Cancel
                    </button>
                </div>
            )}
            <AutoTextarea
                className="compose-input"
                placeholder={placeholder}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                maxLength={maxLength + 50} // Allow some overflow for better UX
                autoFocus={autoFocus}
            />
            {attachments.length > 0 && (
                <div className="compose-media-grid">
                    {attachments.map((item) => {
                        const mediaKind = getMediaKind(item.mimeType);
                        return (
                            <div className={`compose-media-item ${mediaKind === 'audio' ? 'audio' : ''}`} key={item.id}>
                                {mediaKind === 'video' ? (
                                    <video src={item.url} muted playsInline preload="metadata" />
                                ) : mediaKind === 'audio' ? (
                                    <div className="compose-audio-preview">
                                        <Music2 size={22} />
                                        <span>{item.filename || 'Audio track'}</span>
                                    </div>
                                ) : (
                                    <img src={item.url} alt={item.altText || 'Upload preview'} />
                                )}
                                <button
                                    type="button"
                                    className="compose-media-remove"
                                    onClick={() => handleRemoveAttachment(item.id)}
                                >
                                    x
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}

            {linkPreview && (
                <div className="compose-link-preview">
                    <button
                        type="button"
                        className="compose-link-preview-remove"
                        onClick={() => setLinkPreview(null)}
                    >
                        x
                    </button>
                    <VideoEmbed url={linkPreview.url} />
                    {!isEmbeddedVideo && (
                        <div className="link-preview-card mini">
                            {linkPreview.type === 'video' && linkPreview.videoUrl ? (
                                <div className="link-preview-image">
                                    <video
                                        src={linkPreview.videoUrl}
                                        poster={previewImage || undefined}
                                        muted
                                        playsInline
                                        preload="metadata"
                                    />
                                </div>
                            ) : linkPreview.type === 'gallery' && previewMedia.length > 0 ? (
                                <div className="link-preview-gallery compact">
                                    {previewMedia.slice(0, 3).map((item: { url: string }, index: number) => (
                                        <div className="link-preview-gallery-item" key={`${item.url}-${index}`}>
                                            <img src={item.url} alt="" />
                                            {index === Math.min(previewMedia.length, 3) - 1 && previewMedia.length > 3 && (
                                                <span className="link-preview-gallery-more">+{previewMedia.length - 3}</span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            ) : previewImage && (
                                <div className="link-preview-image">
                                    <img src={previewImage} alt="" />
                                </div>
                            )}
                            <div className="link-preview-info">
                                <div className="link-preview-title">{linkPreview.title}</div>
                                <div className="link-preview-url">{new URL(linkPreview.url.startsWith('http') ? linkPreview.url : `https://${linkPreview.url}`).hostname}</div>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {uploadError && (
                <div className="compose-media-error">{uploadError}</div>
            )}
            {storageNotice && (
                <div style={{ color: 'var(--success)', fontSize: '13px', marginTop: '8px' }}>{storageNotice}</div>
            )}
            <div className="compose-footer">
                <div className="compose-footer-left">
                    <span className={`compose-counter ${remaining < 50 ? (remaining < 0 ? 'error' : 'warning') : ''}`}>
                        {remaining}
                    </span>
                    {canPostNsfw && !isNsfwNode && (
                        <label className="compose-nsfw-toggle" title="Mark as sensitive content">
                            <input
                                type="checkbox"
                                checked={isNsfw}
                                onChange={(e) => setIsNsfw(e.target.checked)}
                            />
                            <AlertTriangle size={16} />
                            <span>NSFW</span>
                        </label>
                    )}
                </div>
                <div className="compose-actions">
                    <button
                        type="button"
                        className="compose-media-button"
                        title="Attach media"
                        onClick={handleAddMedia}
                        disabled={isUploading || isCheckingStorage || attachments.length >= 4}
                    >
                        {isUploading || isCheckingStorage ? '...' : <Paperclip size={20} />}
                    </button>
                    <input
                        ref={mediaInputRef}
                        type="file"
                        accept="image/*,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/mp4,audio/aac,audio/wav,audio/ogg,audio/flac"
                        multiple
                        onChange={handleMediaSelect}
                        disabled={isUploading || attachments.length >= 4}
                        className="compose-media-input"
                    />
                    <button
                        className="btn btn-primary"
                        onClick={handleSubmit}
                        disabled={!canSubmit || remaining < 0 || isPosting || isUploading}
                    >
                        {isPosting ? 'Posting...' : isReply ? 'Reply' : 'Post'}
                    </button>
                </div>
            </div>
        </div>
    );
}
