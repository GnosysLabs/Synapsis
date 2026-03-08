'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { HeartIcon, RepeatIcon, MessageIcon, FlagIcon, TrashIcon } from '@/components/Icons';
import { Bot, MoreHorizontal, UserX, VolumeX, Globe } from 'lucide-react';
import { Post } from '@/lib/types';
import { useAuth } from '@/lib/contexts/AuthContext';
import { useToast } from '@/lib/contexts/ToastContext';
import { VideoEmbed } from '@/components/VideoEmbed';
import BlurredVideo from '@/components/BlurredVideo';
import { useFormattedHandle } from '@/lib/utils/handle';
import { useDomain } from '@/lib/contexts/ConfigContext';
import { signedAPI } from '@/lib/api/signed-fetch';

// Component for link preview image that hides on error
function LinkPreviewImage({ src, alt }: { src: string; alt: string }) {
    const [hasError, setHasError] = useState(false);

    if (hasError) return null;

    return (
        <div className="link-preview-image">
            <img
                src={src}
                alt={alt}
                onError={() => setHasError(true)}
            />
        </div>
    );
}

interface PostCardProps {
    post: Post;
    onLike?: (id: string, currentLiked: boolean) => void;
    onRepost?: (id: string, currentReposted: boolean) => Promise<void> | void;
    onComment?: (post: Post) => void;
    onDelete?: (id: string) => void;
    onHide?: (id: string) => void; // Called when post should be hidden (block/mute)
    isDetail?: boolean;
    showThread?: boolean; // Show parent post inline as a thread
    isThreadParent?: boolean; // This post is being shown as a parent in a thread
    parentPostAuthorId?: string; // ID of the parent post's author (for allowing deletion of replies)
}

export function PostCard({ post, onLike, onRepost, onComment, onDelete, onHide, isDetail, showThread = true, isThreadParent, parentPostAuthorId }: PostCardProps) {
    const { user: currentUser, did, handle: currentUserHandle, isIdentityUnlocked } = useAuth();
    const { showToast } = useToast();
    const router = useRouter();
    const [liked, setLiked] = useState(post.isLiked || false);
    const [likesCount, setLikesCount] = useState(post.likesCount || 0);
    const [likePending, setLikePending] = useState(false);
    const [reposted, setReposted] = useState(post.isReposted || false);
    const [repostsCount, setRepostsCount] = useState(post.repostsCount || 0);
    const [repostPending, setRepostPending] = useState(false);
    const [reporting, setReporting] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [showMenu, setShowMenu] = useState(false);
    const domain = useDomain();
    const authorHandle = useFormattedHandle(post.author.handle, post.nodeDomain);
    // Sync state if post changes (e.g. after a re-render from parent)
    useEffect(() => {
        setLiked(post.isLiked || false);
        setLikesCount(post.likesCount || 0);
        setReposted(post.isReposted || false);
        setRepostsCount(post.repostsCount || 0);
    }, [post.isLiked, post.likesCount, post.isReposted, post.repostsCount, post.id]);

    const formatTime = (dateStr: string | Date) => {
        const date = new Date(dateStr);

        if (isNaN(date.getTime())) {
            return '';
        }

        const now = new Date();
        const diff = now.getTime() - date.getTime();

        // If post is in the future (minor clock skew), show "now"
        if (diff < 0) {
            return 'now';
        }

        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (seconds < 60) return 'now';
        if (minutes < 60) return `${minutes}m`;
        if (hours < 24) return `${hours}h`;
        if (days < 7) return `${days}d`;
        return date.toLocaleDateString();
    };

    const handleLike = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        if (likePending) {
            return;
        }

        if (!isIdentityUnlocked) {
            showToast('Please log in to like posts', 'error');
            return;
        }

        const currentLiked = liked;
        const currentLikesCount = likesCount;
        const nextLiked = !currentLiked;
        const nextLikesCount = Math.max(0, currentLikesCount + (currentLiked ? -1 : 1));

        setLiked(nextLiked);
        setLikesCount(nextLikesCount);
        setLikePending(true);

        try {
            await onLike?.(post.id, currentLiked);
        } catch (error) {
            setLiked(currentLiked);
            setLikesCount(currentLikesCount);
            showToast(error instanceof Error ? error.message : 'Failed to update like', 'error');
        } finally {
            setLikePending(false);
        }
    };

    const handleRepost = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        if (repostPending) {
            return;
        }

        if (!isIdentityUnlocked) {
            showToast('Please log in to repost', 'error');
            return;
        }

        const currentReposted = reposted;
        const currentRepostsCount = repostsCount;
        const nextReposted = !currentReposted;
        const nextRepostsCount = Math.max(0, currentRepostsCount + (currentReposted ? -1 : 1));

        setReposted(nextReposted);
        setRepostsCount(nextRepostsCount);
        setRepostPending(true);

        try {
            await onRepost?.(post.id, currentReposted);
        } catch (error) {
            setReposted(currentReposted);
            setRepostsCount(currentRepostsCount);
            showToast(error instanceof Error ? error.message : 'Failed to update repost', 'error');
        } finally {
            setRepostPending(false);
        }
    };

    const handleComment = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        // Navigate to post detail page
        router.push(postUrl);
    };

    const handleReport = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (reporting) return;
        const reason = window.prompt('Why are you reporting this post?');
        if (!reason || !did || !currentUserHandle) return;
        setReporting(true);
        try {
            const res = await signedAPI.report(
                'post',
                post.id,
                reason,
                did,
                currentUserHandle
            );
            if (!res.ok) {
                if (res.status === 401) {
                    showToast('Please log in to report.', 'error');
                } else {
                    showToast('Report failed. Please try again.', 'error');
                }
            } else {
                showToast('Report submitted. Thank you.', 'success');
            }
        } catch {
            showToast('Report failed. Please try again.', 'error');
        } finally {
            setReporting(false);
        }
    };
    const handleDelete = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (deleting) return;
        if (!window.confirm('Are you sure you want to delete this post? This action cannot be undone.')) return;
        if (!did || !currentUserHandle) return;
        setDeleting(true);
        try {
            const res = await signedAPI.deletePost(post.id, did, currentUserHandle);
            if (res.ok) {
                onDelete?.(post.id);
            } else {
                const data = await res.json();
                showToast(data.error || 'Failed to delete post', 'error');
            }
        } catch {
            showToast('Failed to delete post', 'error');
        } finally {
            setDeleting(false);
        }
    };

    const handleBlockUser = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setShowMenu(false);

        if (!currentUser || !did || !currentUserHandle) {
            showToast('Please log in to block users', 'error');
            return;
        }

        try {
            const res = await signedAPI.blockUser(post.author.handle, did, currentUserHandle);
            if (res.ok) {
                showToast(`Blocked @${post.author.handle}`, 'success');
                onHide?.(post.id);
            } else {
                showToast('Failed to block user', 'error');
            }
        } catch {
            showToast('Failed to block user', 'error');
        }
    };

    const handleMuteUser = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setShowMenu(false);

        if (!currentUser || !did || !currentUserHandle) {
            showToast('Please log in to mute users', 'error');
            return;
        }

        // For now, muting a user is the same as blocking but with different messaging
        // Could be expanded to just hide posts without breaking follows
        try {
            const res = await signedAPI.blockUser(post.author.handle, did, currentUserHandle);
            if (res.ok) {
                showToast(`Muted @${post.author.handle}`, 'success');
                onHide?.(post.id);
            } else {
                showToast('Failed to mute user', 'error');
            }
        } catch {
            showToast('Failed to mute user', 'error');
        }
    };

    const handleMuteNode = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setShowMenu(false);

        if (!currentUser || !did || !currentUserHandle) {
            showToast('Please log in to mute nodes', 'error');
            return;
        }

        // Extract node domain from the post
        const nodeDomain = post.nodeDomain || (post.author.handle.includes('@')
            ? post.author.handle.split('@')[1]
            : null);

        if (!nodeDomain) {
            showToast('Cannot determine node for this post', 'error');
            return;
        }

        try {
            const res = await signedAPI.muteNode(nodeDomain, did, currentUserHandle);
            if (res.ok) {
                showToast(`Muted node: ${nodeDomain}`, 'success');
                onHide?.(post.id);
            } else {
                showToast('Failed to mute node', 'error');
            }
        } catch {
            showToast('Failed to mute node', 'error');
        }
    };

    const postUrl = `/u/${post.author.handle}/posts/${post.id}`;

    // Get the full handle for profile links (includes domain for remote users)
    const getProfileHandle = () => {
        // If handle already has domain, use it
        if (post.author.handle.includes('@')) {
            return post.author.handle;
        }
        // If this is a swarm post from a DIFFERENT node, append the node domain
        if (post.nodeDomain && post.nodeDomain !== domain) {
            return `${post.author.handle}@${post.nodeDomain}`;
        }
        // Local user
        return post.author.handle;
    };
    const profileHandle = getProfileHandle();

    // Decode HTML entities from federated posts (e.g., &amp;rsquo; -> ')
    const decodeHtmlEntities = (text: string): string => {
        const entities: Record<string, string> = {
            '&amp;': '&',
            '&lt;': '<',
            '&gt;': '>',
            '&quot;': '"',
            '&#039;': "'",
            '&apos;': "'",
            '&rsquo;': '\u2019', // '
            '&lsquo;': '\u2018', // '
            '&rdquo;': '\u201D', // "
            '&ldquo;': '\u201C', // "
            '&ndash;': '\u2013', // –
            '&mdash;': '\u2014', // —
            '&hellip;': '\u2026', // …
            '&nbsp;': ' ',
            '&copy;': '\u00A9', // ©
            '&reg;': '\u00AE', // ®
            '&trade;': '\u2122', // ™
            '&euro;': '\u20AC', // €
            '&pound;': '\u00A3', // £
            '&yen;': '\u00A5', // ¥
            '&cent;': '\u00A2', // ¢
        };

        // First decode named entities
        let decoded = text;
        for (const [entity, char] of Object.entries(entities)) {
            decoded = decoded.replace(new RegExp(entity, 'g'), char);
        }

        // Decode numeric entities (&#123; or &#x7B;)
        decoded = decoded.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
        decoded = decoded.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

        // Strip HTML tags (remote posts may contain <p>, <br>, <a> etc.)
        decoded = decoded.replace(/<br\s*\/?>/gi, '\n');
        decoded = decoded.replace(/<\/p>\s*<p>/gi, '\n\n');
        decoded = decoded.replace(/<[^>]+>/g, '');

        return decoded.trim();
    };

    const renderContent = (content: string, hidePreviewUrl?: string) => {
        const decoded = decodeHtmlEntities(content);
        const parts = decoded.split(/(https?:\/\/[^\s]+)/g);
        return parts.map((part, index) => {
            if (part.match(/^https?:\/\/[^\s]+$/)) {
                // If this URL matches the link preview URL, hide it entirely
                if (hidePreviewUrl && part.includes(hidePreviewUrl.replace(/^https?:\/\/(www\.)?/, '').split('/')[0])) {
                    return null;
                }
                // Extract just the domain (TLD)
                try {
                    const url = new URL(part);
                    const domain = url.hostname.replace(/^www\./, '');
                    return (
                        <a
                            key={`url-${index}`}
                            href={part}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title={part}
                        >
                            {domain}
                        </a>
                    );
                } catch {
                    // Fallback if URL parsing fails
                    return (
                        <a
                            key={`url-${index}`}
                            href={part}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                        >
                            {part}
                        </a>
                    );
                }
            }
            // Handle newlines
            if (part.includes('\n')) {
                return part.split('\n').map((line, lineIndex, arr) => (
                    <span key={`text-${index}-${lineIndex}`}>
                        {line}
                        {lineIndex < arr.length - 1 && <br />}
                    </span>
                ));
            }
            return <span key={`text-${index}`}>{part}</span>;
        });
    };

    // Build a synthetic replyTo for swarm replies
    const effectiveReplyTo = post.replyTo || (post.swarmReplyToId && post.swarmReplyToAuthor ? {
        id: post.swarmReplyToId,
        content: post.swarmReplyToContent || '',
        createdAt: post.createdAt, // Use same time as approximation
        likesCount: 0,
        repostsCount: 0,
        repliesCount: 0,
        author: typeof post.swarmReplyToAuthor === 'string'
            ? JSON.parse(post.swarmReplyToAuthor)
            : post.swarmReplyToAuthor,
        isSwarm: true,
        nodeDomain: (typeof post.swarmReplyToAuthor === 'string'
            ? JSON.parse(post.swarmReplyToAuthor)
            : post.swarmReplyToAuthor)?.nodeDomain,
    } as Post : null);
    const replyToHandle = effectiveReplyTo?.author?.handle ? useFormattedHandle(effectiveReplyTo.author.handle, effectiveReplyTo.nodeDomain) : '';

    // If this is a thread parent being rendered, just render the article
    if (isThreadParent) {
        return (
            <article className="post thread-parent">
                <div className="post-header">
                    <Link href={`/u/${profileHandle}`} className="avatar-link" onClick={(e) => e.stopPropagation()}>
                        <div className="avatar">
                            {post.author.avatarUrl ? (
                                <img src={post.author.avatarUrl} alt={post.author.displayName || ''} />
                            ) : (
                                post.author.displayName?.charAt(0).toUpperCase() || post.author.handle.charAt(0).toUpperCase()
                            )}
                        </div>
                    </Link>
                    <div className="post-author">
                        <Link href={`/u/${profileHandle}`} className="post-handle" onClick={(e) => e.stopPropagation()}>
                            {post.author.displayName || post.author.handle}
                        </Link>
                        <span className="post-time">{authorHandle}</span>
                    </div>
                </div>
                <div className="post-content">{renderContent(post.content, post.linkPreviewUrl ?? undefined)}</div>
            </article>
        );
    }

    return (
        <>
            {/* Show parent post as part of thread - only on detail page */}
            {showThread && effectiveReplyTo && isDetail && (
                <div className="thread-container">
                    <PostCard
                        post={effectiveReplyTo}
                        onLike={onLike}
                        onRepost={onRepost}
                        onComment={onComment}
                        onDelete={onDelete}
                        onHide={onHide}
                        showThread={false}
                        isThreadParent={true}
                    />
                </div>
            )}
            <article className={`post ${isDetail ? 'detail' : ''}`}>
                {!isDetail && <Link href={postUrl} className="post-link-overlay" aria-label="View post" />}

                <div className="post-header">
                    <Link href={`/u/${profileHandle}`} className="avatar-link" onClick={(e) => e.stopPropagation()}>
                        <div className="avatar">
                            {post.author.avatarUrl ? (
                                <img src={post.author.avatarUrl} alt={post.author.displayName} />
                            ) : (
                                post.author.displayName?.charAt(0).toUpperCase() || post.author.handle.charAt(0).toUpperCase()
                            )}
                        </div>
                    </Link>
                    <div className="post-author">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <Link href={`/u/${profileHandle}`} className="post-handle" onClick={(e) => e.stopPropagation()}>
                                {post.author.displayName || post.author.handle}
                            </Link>
                            {(post.bot || post.author.isBot) && (
                                <span
                                    style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '3px',
                                        fontSize: '10px',
                                        padding: '2px 6px',
                                        borderRadius: '4px',
                                        background: 'var(--accent-muted)',
                                        color: 'var(--accent)',
                                        fontWeight: 500,
                                    }}
                                    title={post.bot ? `AI Account: ${post.bot.name}` : `AI Account: ${post.author.displayName || post.author.handle}`}
                                >
                                    <Bot size={12} />
                                    AI Account
                                </span>
                            )}
                        </div>
                        <span className="post-time">{authorHandle} · {formatTime(post.createdAt)}</span>
                    </div>
                    {currentUser && currentUser.id !== post.author.id && (
                        <div style={{ position: 'relative', marginLeft: 'auto' }}>
                            <button
                                className="post-menu-btn"
                                onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setShowMenu(!showMenu);
                                }}
                                style={{
                                    background: 'none',
                                    border: 'none',
                                    padding: '4px',
                                    cursor: 'pointer',
                                    color: 'var(--foreground-tertiary)',
                                    borderRadius: '50%',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                }}
                            >
                                <MoreHorizontal size={18} />
                            </button>
                            {showMenu && (
                                <>
                                    <div
                                        style={{
                                            position: 'fixed',
                                            inset: 0,
                                            zIndex: 99,
                                        }}
                                        onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            setShowMenu(false);
                                        }}
                                    />
                                    <div
                                        className="post-menu-dropdown"
                                        style={{
                                            position: 'absolute',
                                            right: 0,
                                            top: '100%',
                                            marginTop: '4px',
                                            background: 'var(--background-secondary)',
                                            border: '1px solid var(--border)',
                                            borderRadius: 'var(--radius-md)',
                                            minWidth: '180px',
                                            zIndex: 100,
                                            overflow: 'hidden',
                                            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                                        }}
                                    >
                                        <button
                                            onClick={handleMuteUser}
                                            style={{
                                                width: '100%',
                                                padding: '10px 14px',
                                                background: 'none',
                                                border: 'none',
                                                textAlign: 'left',
                                                cursor: 'pointer',
                                                color: 'var(--foreground)',
                                                fontSize: '14px',
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '10px',
                                            }}
                                        >
                                            <VolumeX size={16} />
                                            Mute
                                        </button>
                                        <button
                                            onClick={handleBlockUser}
                                            style={{
                                                width: '100%',
                                                padding: '10px 14px',
                                                background: 'none',
                                                border: 'none',
                                                textAlign: 'left',
                                                cursor: 'pointer',
                                                color: 'var(--foreground)',
                                                fontSize: '14px',
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '10px',
                                            }}
                                        >
                                            <UserX size={16} />
                                            Block
                                        </button>
                                        {(post.nodeDomain || post.author.handle.includes('@')) && (
                                            <button
                                                onClick={handleMuteNode}
                                                style={{
                                                    width: '100%',
                                                    padding: '10px 14px',
                                                    background: 'none',
                                                    border: 'none',
                                                    textAlign: 'left',
                                                    cursor: 'pointer',
                                                    color: 'var(--foreground)',
                                                    fontSize: '14px',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: '10px',
                                                    borderTop: '1px solid var(--border)',
                                                }}
                                            >
                                                <Globe size={16} />
                                                Mute node
                                            </button>
                                        )}
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                </div>

                {effectiveReplyTo && !showThread && (
                    <div className="post-reply-to">
                        Replying to <Link href={`/u/${effectiveReplyTo.author.handle}`} onClick={(e) => e.stopPropagation()}>{replyToHandle}</Link>
                    </div>
                )}

                <div className="post-content">{renderContent(post.content, post.linkPreviewUrl ?? undefined)}</div>

                {post.media && post.media.length > 0 && (
                    <div className="post-media-grid">
                        {post.media.map((item) => {
                            const isVideo = item.mimeType?.startsWith('video/');
                            return (
                                <div className="post-media-item" key={item.id}>
                                    {isVideo ? (
                                        <BlurredVideo
                                            src={item.url}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                const video = e.currentTarget;
                                                video.muted = !video.muted;
                                            }}
                                        />
                                    ) : (
                                        <img src={item.url} alt={item.altText || 'Post media'} loading="lazy" />
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}

                {post.linkPreviewUrl && (
                    <VideoEmbed url={post.linkPreviewUrl} />
                )}

                {post.linkPreviewUrl && !post.linkPreviewUrl.match(/(youtube\.com|youtu\.be|vimeo\.com)/) && (
                    <a
                        href={post.linkPreviewUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="link-preview-card"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {post.linkPreviewImage && (
                            <LinkPreviewImage src={post.linkPreviewImage} alt={post.linkPreviewTitle || ''} />
                        )}
                        <div className="link-preview-info">
                            <div className="link-preview-title">{post.linkPreviewTitle ? decodeHtmlEntities(post.linkPreviewTitle) : ''}</div>
                            {post.linkPreviewDescription && (
                                <div className="link-preview-description">{decodeHtmlEntities(post.linkPreviewDescription)}</div>
                            )}
                            <div className="link-preview-url">
                                {new URL(post.linkPreviewUrl.startsWith('http') ? post.linkPreviewUrl : `https://${post.linkPreviewUrl}`).hostname}
                            </div>
                        </div>
                    </a>
                )}

                <div className="post-actions">
                    <button className="post-action" onClick={handleComment}>
                        <MessageIcon />
                        <span>{post.repliesCount || ''}</span>
                    </button>
                    <button className={`post-action ${reposted ? 'reposted' : ''}`} onClick={handleRepost} disabled={repostPending}>
                        <RepeatIcon />
                        <span>{repostsCount || ''}</span>
                    </button>
                    <button className={`post-action ${liked ? 'liked' : ''}`} onClick={handleLike}>
                        <HeartIcon filled={liked} />
                        <span>{likesCount || ''}</span>
                    </button>
                    <button className="post-action" onClick={handleReport} disabled={reporting}>
                        <FlagIcon />
                        <span>{reporting ? '...' : ''}</span>
                    </button>
                    {(currentUser && (
                        currentUser.id === post.author.id ||
                        (post.bot && currentUser.id === post.bot.ownerId) ||
                        (parentPostAuthorId && currentUser.id === parentPostAuthorId) ||
                        // Allow deleting own remote posts where handle might be username@node_domain
                        (post.author.id.startsWith('swarm:') && (
                            post.author.handle === currentUser.handle ||
                            post.author.handle === `${currentUser.handle}@${domain}`
                        ))
                    )) && (
                            <button className="post-action delete-action" onClick={handleDelete} disabled={deleting} title="Delete post">
                                <TrashIcon />
                                <span>{deleting ? '...' : ''}</span>
                            </button>
                        )}
                </div>
            </article>
        </>
    );
}
