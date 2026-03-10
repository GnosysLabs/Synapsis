'use client';

import { useState, useEffect } from 'react';
import AutoTextarea from '@/components/AutoTextarea';
import { Post, Attachment } from '@/lib/types';
import { ImageIcon, AlertTriangle, Film } from 'lucide-react';
import { VideoEmbed } from '@/components/VideoEmbed';
import { useFormattedHandle } from '@/lib/utils/handle';
import { useAuth } from '@/lib/contexts/AuthContext';

interface MediaAttachment extends Attachment {
    mimeType?: string;
}

interface ComposeProps {
    onPost: (content: string, mediaIds: string[], linkPreview?: any, replyToId?: string, isNsfw?: boolean) => void;
    replyingTo?: Post | null;
    onCancelReply?: () => void;
    placeholder?: string;
    isReply?: boolean;
}

export function Compose({ onPost, replyingTo, onCancelReply, placeholder = "What's happening?", isReply }: ComposeProps) {
    const { isIdentityUnlocked } = useAuth();
    const replyToHandle = replyingTo ? useFormattedHandle(replyingTo.author.handle) : '';
    const [content, setContent] = useState('');
    const [isPosting, setIsPosting] = useState(false);
    const [attachments, setAttachments] = useState<MediaAttachment[]>([]);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [linkPreview, setLinkPreview] = useState<any>(null);
    const [fetchingPreview, setFetchingPreview] = useState(false);
    const [lastDetectedUrl, setLastDetectedUrl] = useState<string | null>(null);
    const [isNsfw, setIsNsfw] = useState(false);
    const [canPostNsfw, setCanPostNsfw] = useState(false);
    const [isNsfwNode, setIsNsfwNode] = useState(false);
    const maxLength = 600;
    const remaining = maxLength - content.length;
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
        if (!content.trim() || isPosting || isUploading) return;

        // With persistence, identity should be unlocked. If not, user needs to re-login
        if (!isIdentityUnlocked) {
            alert('Your session has expired. Please log in again.');
            return;
        }

        setIsPosting(true);
        await onPost(content, attachments.map((item) => item.id).filter(Boolean), linkPreview, replyingTo?.id, isNsfw);
        setContent('');
        setAttachments([]);
        setLinkPreview(null);
        setLastDetectedUrl(null);
        setIsNsfw(false);
        setIsPosting(false);
    };

    const handleMediaSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files || []);
        event.target.value = '';
        if (files.length === 0) return;

        const remainingSlots = Math.max(0, 4 - attachments.length);
        const selectedFiles = files.slice(0, remainingSlots);
        if (selectedFiles.length === 0) return;

        setUploadError(null);
        setIsUploading(true);

        const uploaded: MediaAttachment[] = [];

        for (const file of selectedFiles) {
            try {
                const formData = new FormData();
                formData.append('file', file);
                const res = await fetch('/api/media/upload', {
                    method: 'POST',
                    body: formData,
                });
                const data = await res.json();

                if (!res.ok || !data.media?.id) {
                    throw new Error(data.error || 'Upload failed');
                }

                uploaded.push({
                    id: data.media.id,
                    url: data.media.url || data.url,
                    altText: data.media.altText ?? null,
                    mimeType: data.media.mimeType ?? file.type,
                });
            } catch (error) {
                console.error('Upload failed', error);
                setUploadError('One or more uploads failed. Try again.');
            }
        }

        setAttachments((prev) => [...prev, ...uploaded].slice(0, 4));
        setIsUploading(false);
    };

    const handleRemoveAttachment = (id: string) => {
        setAttachments((prev) => prev.filter((item) => item.id !== id));
    };

    return (
        <div className={`compose ${isReply ? 'reply-compose' : ''}`}>
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
            />
            {attachments.length > 0 && (
                <div className="compose-media-grid">
                    {attachments.map((item) => {
                        const isVideo = item.mimeType?.startsWith('video/');
                        return (
                            <div className="compose-media-item" key={item.id}>
                                {isVideo ? (
                                    <video src={item.url} muted playsInline preload="metadata" />
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
                    <label
                        className="compose-media-button"
                        title="Add media"
                    >
                        {isUploading ? '...' : <ImageIcon size={20} />}
                        <input
                            type="file"
                            accept="image/*,video/mp4,video/webm,video/quicktime"
                            multiple
                            onChange={handleMediaSelect}
                            disabled={isUploading || attachments.length >= 4}
                            className="compose-media-input"
                        />
                    </label>
                    <button
                        className="btn btn-primary"
                        onClick={handleSubmit}
                        disabled={!content.trim() || remaining < 0 || isPosting || isUploading}
                    >
                        {isPosting ? 'Posting...' : isReply ? 'Reply' : 'Post'}
                    </button>
                </div>
            </div>
        </div>
    );
}
