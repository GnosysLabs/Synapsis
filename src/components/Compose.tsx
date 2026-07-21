'use client';

import { useState, useEffect, useId, useRef } from 'react';
import Image from 'next/image';
import AutoTextarea from '@/components/AutoTextarea';
import { Post, Attachment, type SignedMediaDescriptor } from '@/lib/types';
import { AlertTriangle, FolderPlus, Music2, Paperclip } from 'lucide-react';
import { VideoEmbed } from '@/components/VideoEmbed';
import { useFormattedHandle } from '@/lib/utils/handle';
import { useAuth } from '@/lib/contexts/AuthContext';
import { useDomain } from '@/lib/contexts/ConfigContext';
import { StorageConfigurationPrompt } from '@/components/StorageConfigurationPrompt';
import { getStorageProvider, MediaUploadError, uploadMediaFile } from '@/lib/stuffbox/browser-upload';
import { getMediaKind } from '@/lib/media/upload-policy';
import { primeVideoPreviewFrame } from '@/lib/media/video-preview';
import { AvatarImage } from '@/components/AvatarImage';
import {
    findLinkPreviewUrlInText,
    proxiedLinkPreviewImageUrl,
    type LinkPreviewData,
} from '@/lib/media/linkPreview';
import {
    buildVideoLinkPreview,
    findVideoEmbedUrlInText,
    parseVideoEmbedUrl,
} from '@/lib/media/video-embed';
import {
    getActiveMentionQuery,
    canonicalizeMentionsInContent,
    replaceMentionQuery,
    type ActiveMentionQuery,
} from '@/lib/mentions/parser';
import { type MentionSuggestion } from '@/lib/mentions/suggestions';
import { displayAccountAddress, parseAccountAddress } from '@/lib/identity/account-address';
import { useAppDialog } from '@/lib/contexts/DialogContext';
import { PostCollectionPicker } from '@/components/PostCollectionPicker';

interface MediaAttachment extends Attachment {
    clientId?: string;
    mimeType?: string;
    filename?: string;
    previewUrl?: string;
    file?: File;
    uploadState?: 'uploading' | 'ready' | 'failed';
    uploadProgress?: number;
}

interface PendingMediaUpload {
    id: string;
    file: File;
}

interface ComposeProps {
    onPost: (
        content: string,
        mediaIds: string[],
        linkPreview?: LinkPreviewData | null,
        replyToId?: string,
        isNsfw?: boolean,
        mediaManifest?: SignedMediaDescriptor[],
        collectionIds?: string[],
    ) => void | boolean | Promise<void | boolean>;
    onPosted?: () => void;
    replyingTo?: Post | null;
    onCancelReply?: () => void;
    placeholder?: string;
    isReply?: boolean;
    autoFocus?: boolean;
}

export function Compose({ onPost, onPosted, replyingTo, onCancelReply, placeholder = "What's happening?", isReply, autoFocus = false }: ComposeProps) {
    const { isIdentityUnlocked, handle: currentHandle } = useAuth();
    const domain = useDomain();
    const { showAlert } = useAppDialog();
    const replyToHandle = useFormattedHandle(
        replyingTo?.author.handle || '',
        replyingTo?.author.nodeDomain || replyingTo?.nodeDomain,
    );
    const [content, setContent] = useState('');
    const [isPosting, setIsPosting] = useState(false);
    const [attachments, setAttachments] = useState<MediaAttachment[]>([]);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [storageNotice, setStorageNotice] = useState<string | null>(null);
    const [pendingStorageUploads, setPendingStorageUploads] = useState<PendingMediaUpload[]>([]);
    const [showStorageConfiguration, setShowStorageConfiguration] = useState(false);
    const [linkPreview, setLinkPreview] = useState<LinkPreviewData | null>(null);
    const [linkPreviewSuppressed, setLinkPreviewSuppressed] = useState(false);
    const [lastDetectedUrl, setLastDetectedUrl] = useState<string | null>(null);
    const [isNsfw, setIsNsfw] = useState(false);
    const [canPostNsfw, setCanPostNsfw] = useState(false);
    const [isNsfwNode, setIsNsfwNode] = useState(false);
    const [selectedCollectionIds, setSelectedCollectionIds] = useState<string[]>([]);
    const [showCollectionPicker, setShowCollectionPicker] = useState(false);
    const mediaInputRef = useRef<HTMLInputElement>(null);
    const storageCheckInFlightRef = useRef(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const attachmentsRef = useRef<MediaAttachment[]>([]);
    const mentionListId = useId();
    const [activeMention, setActiveMention] = useState<ActiveMentionQuery | null>(null);
    const [mentionSuggestions, setMentionSuggestions] = useState<MentionSuggestion[]>([]);
    const [mentionLoading, setMentionLoading] = useState(false);
    const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
    const maxLength = 600;
    const remaining = maxLength - content.length;
    const hasUnreadyAttachments = attachments.some((item) => item.uploadState && item.uploadState !== 'ready');
    const canSubmit = (content.trim().length > 0 || attachments.length > 0) && !hasUnreadyAttachments;
    const previewMedia = linkPreview?.media?.length
        ? linkPreview.media
        : linkPreview?.image
            ? [{ url: linkPreview.image }]
            : [];
    const previewImage = previewMedia[0]?.url || linkPreview?.image || null;
    const isEmbeddedVideo = Boolean(linkPreview?.url && parseVideoEmbedUrl(linkPreview.url));
    const canChooseCollections = !isReply && !replyingTo;

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

    useEffect(() => {
        attachmentsRef.current = attachments;
    }, [attachments]);

    useEffect(() => () => {
        for (const attachment of attachmentsRef.current) {
            if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
        }
    }, []);

    // Detect URLs in content
    useEffect(() => {
        const url = findVideoEmbedUrlInText(content) || findLinkPreviewUrlInText(content);
        if (url) {
            if (url !== lastDetectedUrl) {
                setLastDetectedUrl(url);
                setLinkPreviewSuppressed(false);
                fetchPreview(url);
            }
        } else {
            setLinkPreview(null);
            setLastDetectedUrl(null);
            setLinkPreviewSuppressed(false);
        }
    }, [content, lastDetectedUrl]);

    useEffect(() => {
        if (!activeMention) {
            setMentionSuggestions([]);
            setMentionLoading(false);
            return;
        }

        const controller = new AbortController();
        const timeout = window.setTimeout(async () => {
            setMentionLoading(true);
            try {
                const response = await fetch(
                    `/api/mentions/suggestions?q=${encodeURIComponent(activeMention.query)}&limit=8`,
                    { signal: controller.signal, cache: 'no-store' },
                );
                if (!response.ok) {
                    setMentionSuggestions([]);
                    return;
                }
                const data = await response.json();
                const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
                setMentionSuggestions(suggestions);
                setSelectedMentionIndex(0);
            } catch (error) {
                if (!(error instanceof DOMException && error.name === 'AbortError')) {
                    console.warn('[Compose] Mention suggestions failed:', error);
                }
            } finally {
                if (!controller.signal.aborted) setMentionLoading(false);
            }
        }, 160);

        return () => {
            window.clearTimeout(timeout);
            controller.abort();
        };
    }, [activeMention]);

    const syncActiveMention = (value: string, caret: number | null) => {
        setActiveMention(getActiveMentionQuery(value, caret ?? value.length));
    };

    const chooseMention = (suggestion: MentionSuggestion) => {
        if (!activeMention) return;
        if (!parseAccountAddress(suggestion.handle)) return;
        const replacement = replaceMentionQuery(content, activeMention, suggestion.handle);
        setContent(replacement.content);
        setActiveMention(null);
        setMentionSuggestions([]);
        requestAnimationFrame(() => {
            textareaRef.current?.focus();
            textareaRef.current?.setSelectionRange(replacement.caret, replacement.caret);
        });
    };

    const handleMentionKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (!activeMention || mentionSuggestions.length === 0) {
            if (event.key === 'Escape') setActiveMention(null);
            return;
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setSelectedMentionIndex((index) => (index + 1) % mentionSuggestions.length);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setSelectedMentionIndex((index) => (index - 1 + mentionSuggestions.length) % mentionSuggestions.length);
        } else if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            chooseMention(mentionSuggestions[selectedMentionIndex]);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            setActiveMention(null);
            setMentionSuggestions([]);
        }
    };

    const fetchPreview = async (url: string) => {
        const videoPreview = buildVideoLinkPreview(url);
        if (videoPreview) {
            setLinkPreview(videoPreview);
            return;
        }

        try {
            const res = await fetch(`/api/media/preview?url=${encodeURIComponent(url)}`);
            if (res.ok) {
                const data = await res.json();
                setLinkPreview(data);
            }
        } catch (err) {
            console.error('Preview error', err);
        }
    };

    const handleSubmit = async () => {
        if (!canSubmit || isPosting || isUploading) return;

        // With persistence, identity should be unlocked. If not, user needs to re-login
        if (!isIdentityUnlocked) {
            await showAlert({
                title: 'Session expired',
                message: 'Please log in again before publishing your post.',
                dismissLabel: 'Got it',
            });
            return;
        }

        const canonicalContent = canonicalizeMentionsInContent(content, domain);
        if (canonicalContent.length > maxLength) {
            setContent(canonicalContent);
            await showAlert({
                title: 'Post is too long',
                message: 'Full account addresses made this post longer than the limit. Shorten it and try again.',
                dismissLabel: 'Got it',
            });
            return;
        }

        setIsPosting(true);
        try {
            const posted = await onPost(
                canonicalContent,
                attachments.map((item) => item.id).filter(Boolean),
                linkPreviewSuppressed ? null : linkPreview || undefined,
                replyingTo?.id,
                isNsfw,
                attachments.map((item) => ({
                    id: item.id,
                    url: item.url,
                    altText: item.altText ?? null,
                    mimeType: item.mimeType ?? null,
                })),
                canChooseCollections ? selectedCollectionIds : [],
            );
            if (posted === false) {
                setIsPosting(false);
                return;
            }

            setContent('');
            for (const attachment of attachments) {
                if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
            }
            setAttachments([]);
            setLinkPreview(null);
            setLastDetectedUrl(null);
            setLinkPreviewSuppressed(false);
            setIsNsfw(false);
            setSelectedCollectionIds([]);
            setIsPosting(false);
            onPosted?.();
        } catch (error) {
            setIsPosting(false);
            throw error;
        }
    };

    const updatePendingAttachment = (id: string, update: Partial<MediaAttachment>) => {
        setAttachments((current) => current.map((attachment) => (
            attachment.id === id ? { ...attachment, ...update } : attachment
        )));
    };

    const uploadPendingAttachments = async (pendingUploads: PendingMediaUpload[]) => {
        if (pendingUploads.length === 0) return;

        setUploadError(null);
        setIsUploading(true);

        for (let index = 0; index < pendingUploads.length; index += 1) {
            const pending = pendingUploads[index];
            if (!attachmentsRef.current.some((attachment) => attachment.id === pending.id)) continue;

            updatePendingAttachment(pending.id, { uploadState: 'uploading', uploadProgress: 0 });
            try {
                const media = await uploadMediaFile(pending.file, (progress) => {
                    updatePendingAttachment(pending.id, { uploadProgress: progress });
                });

                setAttachments((current) => current.map((attachment) => (
                    attachment.id === pending.id
                        ? {
                            ...attachment,
                            id: media.id,
                            url: media.url,
                            altText: media.altText ?? null,
                            mimeType: media.mimeType ?? pending.file.type,
                            file: undefined,
                            uploadState: 'ready',
                            uploadProgress: 1,
                        }
                        : attachment
                )));
            } catch (error) {
                console.error('Upload failed', error);
                updatePendingAttachment(pending.id, { uploadState: 'failed', uploadProgress: 0 });

                if (error instanceof MediaUploadError && error.code === 'STORAGE_NOT_CONFIGURED') {
                    const remaining = pendingUploads.slice(index);
                    for (const waiting of remaining) {
                        updatePendingAttachment(waiting.id, { uploadState: 'failed', uploadProgress: 0 });
                    }
                    setPendingStorageUploads(remaining);
                    setShowStorageConfiguration(true);
                    setIsUploading(false);
                    return;
                }

                setUploadError(
                    error instanceof MediaUploadError
                        ? error.message
                        : 'One or more uploads failed. Retry the failed attachment.',
                );
            }
        }

        setIsUploading(false);
    };

    const uploadMediaFiles = async (files: File[]) => {
        const remainingSlots = Math.max(0, 4 - attachments.length);
        const selectedFiles = files.slice(0, remainingSlots);
        if (selectedFiles.length === 0) return;

        setUploadError(null);
        const pendingUploads = selectedFiles.map((file) => {
            const id = `local-${crypto.randomUUID()}`;
            return { id, file };
        });
        const optimisticAttachments = pendingUploads.map(({ id, file }): MediaAttachment => {
            const previewUrl = URL.createObjectURL(file);
            return {
                id,
                clientId: id,
                url: previewUrl,
                previewUrl,
                file,
                altText: null,
                mimeType: file.type,
                filename: file.name,
                uploadState: 'uploading',
                uploadProgress: 0,
            };
        });

        attachmentsRef.current = [...attachmentsRef.current, ...optimisticAttachments].slice(0, 4);
        setAttachments(attachmentsRef.current);
        await uploadPendingAttachments(pendingUploads);
    };

    const handleMediaSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files || []);
        event.target.value = '';
        if (files.length === 0) return;
        await uploadMediaFiles(files);
    };

    const handleAddMedia = async () => {
        if (storageCheckInFlightRef.current) return;
        storageCheckInFlightRef.current = true;
        setUploadError(null);
        setStorageNotice(null);
        try {
            if (!await getStorageProvider()) {
                setShowStorageConfiguration(true);
                return;
            }
            mediaInputRef.current?.click();
        } catch (error) {
            setUploadError(error instanceof Error ? error.message : 'Unable to check media storage');
        } finally {
            storageCheckInFlightRef.current = false;
        }
    };

    const handleRemoveAttachment = (id: string) => {
        setAttachments((current) => {
            const removed = current.find((item) => item.id === id);
            if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
            const next = current.filter((item) => item.id !== id);
            attachmentsRef.current = next;
            return next;
        });
    };

    const handleRetryAttachment = async (attachment: MediaAttachment) => {
        if (!attachment.file || isUploading) return;
        await uploadPendingAttachments([{ id: attachment.id, file: attachment.file }]);
    };

    return (
        <div className={`compose ${isReply ? 'reply-compose' : ''}`}>
            <StorageConfigurationPrompt
                open={showStorageConfiguration}
                onConfigured={async () => {
                    setShowStorageConfiguration(false);
                    const pendingUploads = pendingStorageUploads;
                    setPendingStorageUploads([]);
                    if (pendingUploads.length > 0) {
                        await uploadPendingAttachments(pendingUploads);
                        return;
                    }
                    setStorageNotice('Stuffbox connected. Choose your media to continue.');
                    mediaInputRef.current?.click();
                }}
                onCancel={() => {
                    setShowStorageConfiguration(false);
                    setPendingStorageUploads([]);
                }}
            />
            {showCollectionPicker && currentHandle && (
                <PostCollectionPicker
                    selectedCollectionIds={selectedCollectionIds}
                    onClose={() => setShowCollectionPicker(false)}
                    onSaved={setSelectedCollectionIds}
                />
            )}
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
            <div className="compose-mention-field">
                <AutoTextarea
                    ref={textareaRef}
                    className="compose-input"
                    placeholder={placeholder}
                    value={content}
                    onChange={(event) => {
                        setContent(event.target.value);
                        syncActiveMention(event.target.value, event.target.selectionStart);
                    }}
                    onClick={(event) => syncActiveMention(event.currentTarget.value, event.currentTarget.selectionStart)}
                    onKeyUp={(event) => {
                        if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
                            syncActiveMention(event.currentTarget.value, event.currentTarget.selectionStart);
                        }
                    }}
                    onKeyDown={handleMentionKeyDown}
                    onBlur={() => window.setTimeout(() => setActiveMention(null), 120)}
                    maxLength={maxLength + 50} // Allow some overflow for better UX
                    autoFocus={autoFocus}
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={Boolean(activeMention && (mentionLoading || mentionSuggestions.length > 0))}
                    aria-controls={mentionListId}
                    aria-activedescendant={mentionSuggestions[selectedMentionIndex]
                        ? `${mentionListId}-option-${selectedMentionIndex}`
                        : undefined}
                />
                {activeMention && (mentionLoading || mentionSuggestions.length > 0) && (
                    <div
                        id={mentionListId}
                        className="compose-mention-suggestions"
                        role="listbox"
                        aria-label="Mention suggestions"
                    >
                        {mentionLoading && mentionSuggestions.length === 0 ? (
                            <div className="compose-mention-loading">Finding people…</div>
                        ) : mentionSuggestions.map((suggestion, index) => (
                            <button
                                id={`${mentionListId}-option-${index}`}
                                type="button"
                                role="option"
                                aria-selected={index === selectedMentionIndex}
                                className={`compose-mention-suggestion ${index === selectedMentionIndex ? 'selected' : ''}`}
                                key={suggestion.handle}
                                onMouseDown={(event) => event.preventDefault()}
                                onMouseEnter={() => setSelectedMentionIndex(index)}
                                onClick={() => chooseMention(suggestion)}
                            >
                                <span className="compose-mention-avatar">
                                    <AvatarImage
                                        avatarUrl={suggestion.avatarUrl}
                                        seed={suggestion.handle}
                                        nodeDomain={suggestion.nodeDomain}
                                        isNsfw={suggestion.isNsfw}
                                        nodeIsNsfw={suggestion.nodeIsNsfw}
                                        alt=""
                                    />
                                </span>
                                <span className="compose-mention-identity">
                                    <span className="compose-mention-name">
                                        {suggestion.displayName || parseAccountAddress(suggestion.handle)?.username || suggestion.handle}
                                    </span>
                                    <span className="compose-mention-handle">{displayAccountAddress(suggestion.handle)}</span>
                                </span>
                            </button>
                        ))}
                    </div>
                )}
            </div>
            {attachments.length > 0 && (
                <div className="compose-media-grid">
                    {attachments.map((item) => {
                        const mediaKind = getMediaKind(item.mimeType);
                        return (
                            <div
                                className={`compose-media-item ${mediaKind === 'audio' ? 'audio' : ''} ${item.uploadState || 'ready'}`}
                                key={item.clientId || item.id}
                            >
                                {mediaKind === 'video' ? (
                                    <video
                                        src={item.previewUrl || item.url}
                                        muted
                                        playsInline
                                        preload="auto"
                                        onLoadedMetadata={(event) => primeVideoPreviewFrame(event.currentTarget)}
                                    />
                                ) : mediaKind === 'audio' ? (
                                    <div className="compose-audio-preview">
                                        <Music2 size={22} />
                                        <span>{item.filename || 'Audio track'}</span>
                                    </div>
                                ) : (
                                    <Image unoptimized src={item.previewUrl || item.url} alt={item.altText || 'Upload preview'} width={800} height={600} />
                                )}
                                {item.uploadState === 'uploading' && (
                                    <div className="compose-media-upload-status" role="status" aria-label="Uploading attachment">
                                        <span style={{ width: `${Math.max(6, (item.uploadProgress || 0) * 100)}%` }} />
                                    </div>
                                )}
                                {item.uploadState === 'failed' && (
                                    <button
                                        type="button"
                                        className="compose-media-retry"
                                        onClick={() => handleRetryAttachment(item)}
                                        disabled={isUploading}
                                    >
                                        Retry
                                    </button>
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
                        onClick={() => {
                            setLinkPreview(null);
                            setLinkPreviewSuppressed(true);
                        }}
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
                                        poster={previewImage ? proxiedLinkPreviewImageUrl(previewImage) : undefined}
                                        muted
                                        playsInline
                                        preload="metadata"
                                    />
                                </div>
                            ) : linkPreview.type === 'gallery' && previewMedia.length > 0 ? (
                                <div className="link-preview-gallery compact">
                                    {previewMedia.slice(0, 3).map((item: { url: string }, index: number) => (
                                        <div className="link-preview-gallery-item" key={`${item.url}-${index}`}>
                                            <Image unoptimized src={proxiedLinkPreviewImageUrl(item.url)} alt="" width={640} height={480} />
                                            {index === Math.min(previewMedia.length, 3) - 1 && previewMedia.length > 3 && (
                                                <span className="link-preview-gallery-more">+{previewMedia.length - 3}</span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            ) : previewImage && (
                                <div className="link-preview-image">
                                    <Image unoptimized src={proxiedLinkPreviewImageUrl(previewImage)} alt="" width={640} height={360} />
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
                    {canChooseCollections && (
                        <button
                            type="button"
                            className={`compose-media-button compose-collection-button ${selectedCollectionIds.length > 0 ? 'selected' : ''}`}
                            title="Choose collections"
                            aria-label={selectedCollectionIds.length > 0
                                ? `Choose collections, ${selectedCollectionIds.length} selected`
                                : 'Choose collections'}
                            onClick={() => setShowCollectionPicker(true)}
                            disabled={!currentHandle || isPosting}
                        >
                            <FolderPlus size={20} />
                            {selectedCollectionIds.length > 0 && (
                                <span className="compose-collection-count" aria-hidden="true">
                                    {selectedCollectionIds.length}
                                </span>
                            )}
                        </button>
                    )}
                    <button
                        type="button"
                        className="compose-media-button"
                        title="Attach media"
                        onClick={handleAddMedia}
                        disabled={isUploading || attachments.length >= 4}
                    >
                        {isUploading ? '...' : <Paperclip size={20} />}
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
