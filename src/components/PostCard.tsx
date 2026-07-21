'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { HeartIcon, RepeatIcon, MessageIcon, TrashIcon } from '@/components/Icons';
import { MoreHorizontal, Download, MessageCircle, Link2, Share, TriangleAlert } from 'lucide-react';
import { Post, LinkPreviewMediaItem } from '@/lib/types';
import { useAuth } from '@/lib/contexts/AuthContext';
import { useToast } from '@/lib/contexts/ToastContext';
import { VideoEmbed } from '@/components/VideoEmbed';
import BlurredImage from '@/components/BlurredImage';
import BlurredVideo from '@/components/BlurredVideo';
import {
    getPostPath,
    getProfilePath,
    isHandleOnNode,
    sameAccountHandle,
    useFormattedHandle,
} from '@/lib/utils/handle';
import { useDomain, useRuntimeConfig } from '@/lib/contexts/ConfigContext';
import { signedAPI } from '@/lib/api/signed-fetch';
import {
    proxiedLinkPreviewImageUrl,
    type LinkPreviewData,
} from '@/lib/media/linkPreview';
import { findVideoEmbedUrlInText, parseVideoEmbedUrl } from '@/lib/media/video-embed';
import { AvatarImage } from '@/components/AvatarImage';
import { AudioPlayer } from '@/components/AudioPlayer';
import { getMediaKind } from '@/lib/media/upload-policy';
import { tokenizePostContent } from '@/lib/mentions/parser';
import { dedupeReposters, setReposterInSummary } from '@/lib/posts/node-feed';
import { useAppDialog } from '@/lib/contexts/DialogContext';
import { ChatRecipientPicker } from '@/components/ChatRecipientPicker';
import { buildChatShareHref, type ChatRecipient } from '@/lib/chat/recipients';
import { shouldHideSensitivePost } from '@/lib/nsfw/content-visibility';
import { PostOverflowMenu } from '@/components/PostOverflowMenu';
import { PostCollectionPicker } from '@/components/PostCollectionPicker';
import { isTrustedFederationMediaUrl } from '@/lib/utils/federation';
import { normalizeSameNodePostId } from '@/lib/swarm/post-id';
import {
    displayAccountAddress,
    resolveAccountAddress,
} from '@/lib/identity/account-address';
import { StuffboxBadge } from '@/components/StuffboxBadge';

// Component for link preview image that hides on error
function LinkPreviewImage({ src, alt }: { src: string; alt: string }) {
    const [hasError, setHasError] = useState(false);

    if (hasError) return null;

    return (
        <div className="link-preview-image">
            <Image
                unoptimized
                referrerPolicy="no-referrer"
                src={src}
                alt={alt}
                width={640}
                height={360}
                onError={() => setHasError(true)}
            />
        </div>
    );
}

function parseLegacySwarmReplyAuthor(value: unknown): Post['swarmReplyToAuthor'] {
    let candidate = value;
    if (typeof value === 'string') {
        try {
            candidate = JSON.parse(value) as unknown;
        } catch {
            return null;
        }
    }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const record = candidate as Record<string, unknown>;
    if (typeof record.handle !== 'string' || !record.handle.trim() || record.handle.length > 640) {
        return null;
    }
    const nodeDomain = typeof record.nodeDomain === 'string' ? record.nodeDomain : null;
    const address = resolveAccountAddress(record.handle, nodeDomain);
    if (!address) return null;
    return {
        handle: address.canonical,
        displayName: typeof record.displayName === 'string'
            ? record.displayName.slice(0, 160)
            : null,
        avatarUrl: typeof record.avatarUrl === 'string' ? record.avatarUrl : null,
        nodeDomain: address.homeDomain,
    };
}

function isPlaceholderPreview(post: Post): boolean {
    if (!post.linkPreviewUrl) {
        return false;
    }

    try {
        const hostname = new URL(
            post.linkPreviewUrl.startsWith('http') ? post.linkPreviewUrl : `https://${post.linkPreviewUrl}`
        ).hostname.replace(/^www\./, '').toLowerCase();
        const title = post.linkPreviewTitle?.trim().toLowerCase() || '';
        const hasRichData = Boolean(
            post.linkPreviewDescription ||
            post.linkPreviewImage ||
            post.linkPreviewVideoUrl ||
            (post.linkPreviewMedia && post.linkPreviewMedia.length > 0)
        );

        if (hasRichData) {
            return false;
        }

        return (
            !title ||
            title === 'reddit' ||
            title === hostname ||
            title === `www.${hostname}`
        );
    } catch {
        return false;
    }
}

function LinkPreviewGallery({
    media,
    alt,
    compact = false,
}: {
    media: LinkPreviewMediaItem[];
    alt: string;
    compact?: boolean;
}) {
    const visibleMedia = media.slice(0, compact ? 3 : 4);

    return (
        <div className={`link-preview-gallery ${compact ? 'compact' : ''}`}>
            {visibleMedia.map((item, index) => (
                <div className="link-preview-gallery-item" key={`${item.url}-${index}`}>
                    <Image unoptimized referrerPolicy="no-referrer" src={item.url} alt={alt} width={640} height={480} loading="lazy" />
                    {index === visibleMedia.length - 1 && media.length > visibleMedia.length && (
                        <span className="link-preview-gallery-more">+{media.length - visibleMedia.length}</span>
                    )}
                </div>
            ))}
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
    onImpression?: (post: Post) => void;
    onNotInterested?: (post: Post) => Promise<void> | void;
    isDetail?: boolean;
    showThread?: boolean; // Show parent post inline as a thread
    showParentContext?: boolean; // Show the direct parent above a reply in feed/profile views
    isThreadParent?: boolean; // This post is being shown as a parent in a thread
    isEmbedded?: boolean;
    parentPostAuthorId?: string; // ID of the parent post's author (for allowing deletion of replies)
    onCollectionsChanged?: (collectionIds: string[]) => void;
}

export function PostCard(props: PostCardProps) {
    // Historical databases may contain posts whose user was deleted while
    // SQLite foreign-key enforcement was disabled. Never let one malformed
    // API row crash the entire feed while the repair migration catches up.
    if (!props.post.author) {
        return null;
    }

    return <AuthoredPostCard {...props} />;
}

function AuthoredPostCard({ post: initialPost, onLike, onRepost, onComment, onDelete, onHide, onImpression, onNotInterested, isDetail, showThread = true, showParentContext = false, isThreadParent, isEmbedded = false, parentPostAuthorId, onCollectionsChanged }: PostCardProps) {
    const {
        user: currentUser,
        did,
        handle: currentUserHandle,
        isIdentityUnlocked,
    } = useAuth();
    const { showToast } = useToast();
    const { showAlert, showConfirm, showPrompt } = useAppDialog();
    const router = useRouter();
    const [revealedPost, setRevealedPost] = useState<Post | null>(null);
    const [revealedForViewerKey, setRevealedForViewerKey] = useState<string | null>(null);
    const viewerSensitiveAccessKey = `${currentUser?.id ?? 'anonymous'}:${currentUser?.nsfwEnabled === true ? 'enabled' : 'disabled'}:${currentUser?.ageVerifiedAt ?? 'unverified'}`;
    const revealBelongsToCurrentViewer = revealedForViewerKey === viewerSensitiveAccessKey;
    const post = useMemo(
        () => revealedPost && revealBelongsToCurrentViewer
            ? { ...initialPost, ...revealedPost, author: revealedPost.author || initialPost.author }
            : initialPost,
        [initialPost, revealBelongsToCurrentViewer, revealedPost],
    );
    const [liked, setLiked] = useState(post.isLiked || false);
    const [likesCount, setLikesCount] = useState(post.likesCount || 0);
    const [likePending, setLikePending] = useState(false);
    const [reposted, setReposted] = useState(post.isReposted || false);
    const [repostsCount, setRepostsCount] = useState(post.repostsCount || 0);
    const [reposters, setReposters] = useState(post.repostedBy || []);
    const [reposterCount, setReposterCount] = useState(Math.max(
        post.repostedByCount || 0,
        post.repostedBy?.length || 0,
        post.repostsCount || 0,
    ));
    const [repostPending, setRepostPending] = useState(false);
    const [reporting, setReporting] = useState(false);
    const [feedbackPending, setFeedbackPending] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [showMenu, setShowMenu] = useState(false);
    const [showShareMenu, setShowShareMenu] = useState(false);
    const [showRecipientPicker, setShowRecipientPicker] = useState(false);
    const [showCollectionPicker, setShowCollectionPicker] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [hydratedPreview, setHydratedPreview] = useState<LinkPreviewData | null>(null);
    const [sensitiveContentRevealed, setSensitiveContentRevealed] = useState(false);
    const [revealingSensitiveContent, setRevealingSensitiveContent] = useState(false);
    const articleRef = useRef<HTMLElement | null>(null);
    const domain = useDomain();
    const { config } = useRuntimeConfig();
    const localNodeClassificationKnown = config?.classificationKnown === true;
    const localNodeIsNsfw = localNodeClassificationKnown && config?.isNsfw === true;
    const canRevealSensitiveContent = Boolean(currentUser?.ageVerifiedAt);
    const authorAddress = resolveAccountAddress(
        post.author.handle,
        post.author.nodeDomain || post.nodeDomain || domain,
    );
    const authorCanonicalHandle = authorAddress?.canonical || post.author.handle;
    const contentOriginDomain = post.nodeDomain
        || post.author.nodeDomain
        || authorAddress?.homeDomain
        || domain;
    const isRemotePost = Boolean(
        post.isSwarm
        || post.author.isRemote
        || !authorAddress
        || !isHandleOnNode(authorAddress.canonical, domain)
    );
    // Stored snapshots can outlive a parser deployment, and even a local
    // account can submit a tracking URL through an older client. Every media
    // action stays on Stuffbox/operator-approved origins so neither rendering
    // nor downloading discloses the viewer to an arbitrary host.
    const isSafeRenderedMediaUrl = (value: string | null | undefined): value is string => Boolean(
        value && isTrustedFederationMediaUrl(value)
    );
    const visiblePostMedia = post.media?.filter((item) => isSafeRenderedMediaUrl(item.url));
    const hideSensitiveContent = shouldHideSensitivePost({
        sensitivity: {
            postIsNsfw: post.isNsfw,
            authorIsNsfw: post.author.isNsfw,
            nodeIsNsfw: post.nodeIsNsfw
                ?? post.author.nodeIsNsfw
                ?? (isRemotePost
                    ? undefined
                    : localNodeClassificationKnown ? localNodeIsNsfw : true),
            isRemote: isRemotePost,
        },
        viewer: currentUser,
        localNodeIsNsfw,
    }) && !(sensitiveContentRevealed && revealBelongsToCurrentViewer);
    const authorHandle = useFormattedHandle(authorCanonicalHandle, contentOriginDomain);
    const isOwnPost = Boolean(
        currentUser && (
            currentUser.id === post.author.id ||
            (post.author.id.startsWith('swarm:')
                && sameAccountHandle(authorCanonicalHandle, currentUser.handle))
        )
    );
    const localCollectionPostId = normalizeSameNodePostId(post.id, domain);
    const canDeletePost = Boolean(
        currentUser && (
            isOwnPost ||
            (parentPostAuthorId && currentUser.id === parentPostAuthorId)
        )
    );
    // Sync state if post changes (e.g. after a re-render from parent)
    useEffect(() => {
        setLiked(post.isLiked || false);
        setLikesCount(post.likesCount || 0);
        setReposted(post.isReposted || false);
        setRepostsCount(post.repostsCount || 0);
        setReposters(post.repostedBy || []);
        setReposterCount(Math.max(
            post.repostedByCount || 0,
            post.repostedBy?.length || 0,
            post.repostsCount || 0,
        ));
    }, [
        post.isLiked,
        post.likesCount,
        post.isReposted,
        post.repostsCount,
        post.repostedBy,
        post.repostedByCount,
        post.id,
    ]);

    useEffect(() => {
        setRevealedPost(null);
        setRevealedForViewerKey(null);
        setSensitiveContentRevealed(false);
    }, [initialPost.id, viewerSensitiveAccessKey]);

    useEffect(() => {
        if (!onImpression || isDetail || isEmbedded || isThreadParent || !articleRef.current) return;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let recorded = false;
        const observer = new IntersectionObserver(([entry]) => {
            if (recorded) return;
            if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
                timer ??= setTimeout(() => {
                    recorded = true;
                    onImpression(post);
                    observer.disconnect();
                }, 800);
            } else if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        }, { threshold: [0, 0.5] });
        observer.observe(articleRef.current);
        return () => {
            if (timer) clearTimeout(timer);
            observer.disconnect();
        };
    }, [isDetail, isEmbedded, isThreadParent, onImpression, post]);

    useEffect(() => {
        let cancelled = false;

        // Never turn a hostile peer's embedded link into a background request
        // from this node. Remote cards use only the bounded metadata that was
        // already present in their validated federation payload.
        if (hideSensitiveContent || isRemotePost) {
            setHydratedPreview(null);
            return;
        }

        const missingPreviewData = Boolean(
            post.linkPreviewUrl &&
            !post.linkPreviewTitle &&
            !post.linkPreviewDescription &&
            !post.linkPreviewImage &&
            !post.linkPreviewVideoUrl &&
            (!post.linkPreviewMedia || post.linkPreviewMedia.length === 0)
        );
        const placeholderPreviewData = isPlaceholderPreview(post);

        if ((!missingPreviewData && !placeholderPreviewData) || !post.linkPreviewUrl) {
            setHydratedPreview(null);
            return;
        }

        (async () => {
            try {
                const res = await fetch(`/api/media/preview?url=${encodeURIComponent(post.linkPreviewUrl!)}`);
                if (!res.ok) return;
                const data = await res.json();
                if (!cancelled) {
                    setHydratedPreview(data);
                }
            } catch {
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [
        post.linkPreviewUrl,
        post.linkPreviewTitle,
        post.linkPreviewDescription,
        post.linkPreviewImage,
        post.linkPreviewVideoUrl,
        post.linkPreviewMedia,
        post,
        hideSensitiveContent,
        isRemotePost,
    ]);

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

        if (post.originUnavailable) {
            showToast('This post is unavailable because its origin disconnected federation access.', 'error');
            return;
        }

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

        // Losing federation access must prevent a new repost, but it must
        // never trap the viewer's existing repost on their own profile.
        if (post.originUnavailable && !reposted) {
            showToast('This post is unavailable because its origin disconnected federation access.', 'error');
            return;
        }

        if (repostPending) {
            return;
        }

        if (!isIdentityUnlocked) {
            showToast('Please log in to repost', 'error');
            return;
        }

        const currentReposted = reposted;
        const currentRepostsCount = repostsCount;
        const currentReposters = reposters;
        const currentReposterCount = reposterCount;
        const nextReposted = !currentReposted;
        const nextRepostsCount = Math.max(0, currentRepostsCount + (currentReposted ? -1 : 1));
        const nextReposterCount = Math.max(0, currentReposterCount + (currentReposted ? -1 : 1));
        const nextSummary = currentUser
            ? setReposterInSummary(
                currentReposters,
                nextReposterCount,
                { ...currentUser, nodeDomain: domain },
                nextReposted,
            )
            : { repostedBy: currentReposters, repostedByCount: currentReposterCount };

        setReposted(nextReposted);
        setRepostsCount(nextRepostsCount);
        setReposters(nextSummary.repostedBy);
        setReposterCount(nextSummary.repostedByCount);
        setRepostPending(true);

        try {
            await onRepost?.(post.id, currentReposted);
        } catch (error) {
            setReposted(currentReposted);
            setRepostsCount(currentRepostsCount);
            setReposters(currentReposters);
            setReposterCount(currentReposterCount);
            showToast(error instanceof Error ? error.message : 'Failed to update repost', 'error');
        } finally {
            setRepostPending(false);
        }
    };

    const handleComment = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (post.originUnavailable) {
            showToast('This post is unavailable because its origin disconnected federation access.', 'error');
            return;
        }
        // Navigate to post detail page
        router.push(postUrl);
    };

    const handleReport = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (reporting) return;
        setShowMenu(false);
        if (!currentUser || !isIdentityUnlocked || !did || !currentUserHandle) {
            showToast('Your session expired. Please sign in again.', 'error');
            router.push('/login');
            return;
        }
        const reason = await showPrompt({
            title: 'Report post',
            message: 'Tell the moderation team what is wrong with this post.',
            inputLabel: 'Reason for reporting',
            placeholder: 'Describe the issue',
            confirmLabel: 'Submit report',
            required: true,
        });
        const trimmedReason = reason?.trim() || '';
        if (!trimmedReason) return;
        if (trimmedReason.length < 3) {
            showToast('Please enter at least 3 characters for the report reason.', 'error');
            return;
        }
        setReporting(true);
        try {
            const res = await signedAPI.report(
                'post',
                post.id,
                trimmedReason,
                did,
                currentUserHandle
            );
            if (!res.ok) {
                if (res.status === 401) {
                    showToast('Your session expired. Please sign in again.', 'error');
                    router.push('/login');
                } else {
                    const data = await res.json().catch(() => null);
                    showToast(data?.error || 'Report failed. Please try again.', 'error');
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

    const handleNotInterested = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!onNotInterested || feedbackPending) return;
        setShowMenu(false);
        setFeedbackPending(true);
        try {
            await onNotInterested(post);
            onHide?.(post.id);
            showToast('We will show you fewer posts like this.', 'success');
        } catch (error) {
            showToast(error instanceof Error ? error.message : 'Could not save feedback', 'error');
        } finally {
            setFeedbackPending(false);
        }
    };
    const handleDelete = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (deleting) return;
        setShowMenu(false);
        if (!isIdentityUnlocked) {
            setShowMenu(false);
            showToast('Your session expired. Please sign in again.', 'error');
            router.push('/login');
            return;
        }
        const confirmed = await showConfirm({
            title: 'Delete post?',
            message: 'This post will be permanently deleted. This action cannot be undone.',
            confirmLabel: 'Delete post',
            tone: 'danger',
        });
        if (!confirmed) return;
        if (!did || !currentUserHandle) {
            await showAlert({
                title: 'Post was not deleted',
                message: 'Synapsis could not authorize this deletion. Sign in again and retry. Nothing was deleted.',
                confirmLabel: 'OK',
                tone: 'danger',
            });
            return;
        }
        setDeleting(true);
        try {
            const res = await signedAPI.deletePost(post.id, did, currentUserHandle);
            if (res.ok) {
                onDelete?.(post.id);
            } else {
                const data = await res.json().catch(() => null) as { error?: unknown } | null;
                const serverMessage = typeof data?.error === 'string' ? data.error : null;
                const retryAfter = Number.parseInt(res.headers.get('Retry-After') || '', 10);
                const fallbackMessage = res.status === 429
                    ? `Too many posts were deleted too quickly. Nothing was deleted. Wait ${Number.isFinite(retryAfter) ? retryAfter : 60} seconds and try again.`
                    : `The post could not be deleted (${res.status}). Nothing was deleted. Try again.`;
                await showAlert({
                    title: 'Post was not deleted',
                    message: serverMessage || fallbackMessage,
                    confirmLabel: 'OK',
                    tone: 'danger',
                });
            }
        } catch (error) {
            await showAlert({
                title: 'Post was not deleted',
                message: error instanceof Error
                    ? `Synapsis could not complete the deletion: ${error.message}. Nothing was deleted.`
                    : 'Synapsis could not complete the deletion. Nothing was deleted. Check your connection and try again.',
                confirmLabel: 'OK',
                tone: 'danger',
            });
        } finally {
            setDeleting(false);
        }
    };

    const handleAddToCollection = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setShowMenu(false);
        setShowCollectionPicker(true);
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
            const res = await signedAPI.blockUser(authorCanonicalHandle, did, currentUserHandle);
            if (res.ok) {
                showToast(`Blocked ${displayAccountAddress(authorCanonicalHandle)}`, 'success');
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
            const res = await signedAPI.blockUser(authorCanonicalHandle, did, currentUserHandle);
            if (res.ok) {
                showToast(`Muted ${displayAccountAddress(authorCanonicalHandle)}`, 'success');
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

        const nodeDomain = post.nodeDomain || authorAddress?.homeDomain || null;

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

    const postUrl = getPostPath(authorCanonicalHandle, post.id, contentOriginDomain);

    const getAbsolutePostUrl = () => new URL(postUrl, window.location.origin).toString();

    const handleSendViaChat = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setShowShareMenu(false);

        if (!currentUser) {
            showToast('Please log in to send posts via chat', 'error');
            return;
        }

        setShowRecipientPicker(true);
    };

    const handleRecipientSelected = (recipient: ChatRecipient) => {
        setShowRecipientPicker(false);
        router.push(buildChatShareHref(recipient.handle, getAbsolutePostUrl()));
    };

    const handleCopyLink = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setShowShareMenu(false);

        try {
            await navigator.clipboard.writeText(getAbsolutePostUrl());
            showToast('Post link copied', 'success');
        } catch {
            showToast('Could not copy the post link', 'error');
        }
    };

    const handleSystemShare = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setShowShareMenu(false);

        const url = getAbsolutePostUrl();
        if (!navigator.share) {
            try {
                await navigator.clipboard.writeText(url);
                showToast('Sharing is not available here, so the link was copied', 'success');
            } catch {
                showToast('Sharing is not available in this browser', 'error');
            }
            return;
        }

        try {
            await navigator.share({
                title: `${post.author.displayName || post.author.handle} on Synapsis`,
                text: hideSensitiveContent
                    ? 'Sensitive post on Synapsis'
                    : post.content || `Media from ${authorHandle}`,
                url,
            });
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') return;
            showToast('Could not share this post', 'error');
        }
    };

    const getDownloadName = (url: string, mimeType: string | null | undefined, index: number) => {
        try {
            const pathName = new URL(url, window.location.origin).pathname;
            const existingName = decodeURIComponent(pathName.split('/').pop() || '');
            if (existingName && existingName.includes('.')) return existingName;
        } catch {
            // Fall through to a generated filename.
        }

        const extension = mimeType?.split('/')[1]?.split(';')[0]?.replace('jpeg', 'jpg') || 'bin';
        return `synapsis-${post.author.handle}-${post.id}-${index + 1}.${extension}`;
    };

    const handleDownloadMedia = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!visiblePostMedia?.length || downloading) return;

        setDownloading(true);
        try {
            for (const [index, item] of visiblePostMedia.entries()) {
                const response = await fetch(item.url);
                if (!response.ok) throw new Error(`Download failed with status ${response.status}`);
                const blob = await response.blob();
                const objectUrl = URL.createObjectURL(blob);
                const anchor = document.createElement('a');
                anchor.href = objectUrl;
                anchor.download = getDownloadName(item.url, item.mimeType || blob.type, index);
                document.body.appendChild(anchor);
                anchor.click();
                anchor.remove();
                window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
            }
        } catch {
            showToast('Could not download this media', 'error');
        } finally {
            setDownloading(false);
        }
    };

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
        const tokens = tokenizePostContent(decoded, contentOriginDomain);
        return tokens.map((token, index) => {
            if (token.type === 'mention') {
                return (
                    <Link
                        key={`mention-${token.start}-${token.end}`}
                        href={getProfilePath(token.canonicalHandle)}
                        className="mention-link"
                        onClick={(event) => event.stopPropagation()}
                        title={displayAccountAddress(token.canonicalHandle)}
                    >
                        {displayAccountAddress(token.canonicalHandle)}
                    </Link>
                );
            }

            if (token.type === 'url') {
                const part = token.value;
                if (hidePreviewUrl) {
                    try {
                        if (new URL(part).toString() === new URL(hidePreviewUrl).toString()) {
                            return null;
                        }
                    } catch {
                        // Keep rendering malformed legacy values as ordinary text links.
                    }
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
            return <span key={`text-${token.start}-${index}`}>{token.value}</span>;
        });
    };

    // Build a synthetic replyTo for swarm replies
    const legacySwarmReplyAuthor = parseLegacySwarmReplyAuthor(post.swarmReplyToAuthor);
    const effectiveReplyTo = post.replyTo || (post.swarmReplyToId && legacySwarmReplyAuthor ? {
        id: post.swarmReplyToId,
        content: post.swarmReplyToContent || '',
        createdAt: post.createdAt, // Use same time as approximation
        likesCount: 0,
        repostsCount: 0,
        repliesCount: 0,
        author: legacySwarmReplyAuthor,
        isSwarm: true,
        nodeDomain: legacySwarmReplyAuthor.nodeDomain,
    } as Post : null);
    const replyToHandle = useFormattedHandle(
        effectiveReplyTo?.author?.handle || '',
        effectiveReplyTo?.nodeDomain,
    );
    const repostHandle = useFormattedHandle(authorCanonicalHandle, contentOriginDomain);
    const hasOwnContent = decodeHtmlEntities(post.content).trim().length > 0;
    const isRepostEvent = Boolean(post.repostOf);
    const uniqueReposters = dedupeReposters(reposters, domain);
    const visibleReposters = uniqueReposters.slice(0, 3);
    const hiddenReposters = Math.max(0, reposterCount - visibleReposters.length);
    const candidatePreviewImage = hydratedPreview?.image || post.linkPreviewImage || null;
    const candidatePreviewVideoUrl = hydratedPreview?.videoUrl || post.linkPreviewVideoUrl || null;
    const candidatePreviewMedia = hydratedPreview?.media || post.linkPreviewMedia || null;
    const effectivePreview = {
        url: hydratedPreview?.url || post.linkPreviewUrl || null,
        title: hydratedPreview?.title || post.linkPreviewTitle || null,
        description: hydratedPreview?.description || post.linkPreviewDescription || null,
        image: candidatePreviewImage ? proxiedLinkPreviewImageUrl(candidatePreviewImage) : null,
        type: hydratedPreview?.type || post.linkPreviewType || null,
        videoUrl: isSafeRenderedMediaUrl(candidatePreviewVideoUrl) ? candidatePreviewVideoUrl : null,
        media: candidatePreviewMedia?.map((item) => ({
            ...item,
            url: proxiedLinkPreviewImageUrl(item.url),
        })) || null,
    };
    const rawPreviewMedia = (() => {
        const mediaJson = (post as Post & { linkPreviewMediaJson?: string | null }).linkPreviewMediaJson;
        if (!mediaJson) {
            return [];
        }
        try {
            const parsed = JSON.parse(mediaJson);
            return Array.isArray(parsed)
                ? parsed.filter((item): item is LinkPreviewMediaItem => Boolean(
                    item
                    && typeof item === 'object'
                    && typeof item.url === 'string'
                ))
                .map((item) => ({
                    ...item,
                    url: proxiedLinkPreviewImageUrl(item.url),
                }))
                : [];
        } catch {
            return [];
        }
    })();
    const previewMedia = (effectivePreview.media && effectivePreview.media.length > 0)
        ? effectivePreview.media
        : rawPreviewMedia.length > 0
            ? rawPreviewMedia
        : effectivePreview.image
            ? [{ url: effectivePreview.image }]
            : [];
    const previewImage = previewMedia[0]?.url || effectivePreview.image || null;
    const previewVideoEmbed = effectivePreview.url
        ? parseVideoEmbedUrl(effectivePreview.url)
        : null;
    const contentVideoEmbedUrl = findVideoEmbedUrlInText(decodeHtmlEntities(post.content));
    const embeddedVideoUrl = previewVideoEmbed?.sourceUrl || contentVideoEmbedUrl;
    const isRichVideoPreview = effectivePreview.type === 'video' && Boolean(effectivePreview.videoUrl);
    const isGalleryPreview = effectivePreview.type === 'gallery' && previewMedia.length > 1;

    const renderLinkPreviewCard = (compact = false) => {
        if (!effectivePreview.url || previewVideoEmbed) {
            return null;
        }

        return (
            <a
                href={effectivePreview.url}
                target="_blank"
                rel="noopener noreferrer"
                className={`link-preview-card ${compact ? 'mini' : ''}`}
                onClick={(e) => e.stopPropagation()}
            >
                {isRichVideoPreview && effectivePreview.videoUrl ? (
                    <div className="link-preview-video">
                        <video
                            src={effectivePreview.videoUrl}
                            poster={previewImage || undefined}
                            controls
                            playsInline
                            preload="metadata"
                        />
                    </div>
                ) : isGalleryPreview ? (
                    <LinkPreviewGallery
                        media={previewMedia}
                        alt={effectivePreview.title || 'Link preview'}
                        compact={compact}
                    />
                ) : previewImage ? (
                    <LinkPreviewImage src={previewImage} alt={effectivePreview.title || ''} />
                ) : null}
                <div className="link-preview-info">
                    <div className="link-preview-title">{effectivePreview.title ? decodeHtmlEntities(effectivePreview.title) : ''}</div>
                    {effectivePreview.description && (
                        <div className="link-preview-description">{decodeHtmlEntities(effectivePreview.description)}</div>
                    )}
                    <div className="link-preview-url">
                        {new URL(effectivePreview.url.startsWith('http') ? effectivePreview.url : `https://${effectivePreview.url}`).hostname}
                    </div>
                </div>
            </a>
        );
    };

    const renderPostMedia = () => visiblePostMedia && visiblePostMedia.length > 0 ? (
        <div className="post-media-grid">
            {visiblePostMedia.map((item) => {
                const mediaKind = getMediaKind(item.mimeType);
                return (
                    <div className={`post-media-item ${mediaKind === 'audio' ? 'audio' : ''}`} key={item.id}>
                        {mediaKind === 'video' ? (
                            <BlurredVideo src={item.url} />
                        ) : mediaKind === 'audio' ? (
                            <AudioPlayer
                                src={item.url}
                                title={`Audio by ${post.author.displayName || post.author.handle}`}
                            />
                        ) : (
                            <BlurredImage
                                src={item.url}
                                alt={item.altText || 'Post media'}
                            />
                        )}
                    </div>
                );
            })}
        </div>
    ) : null;

    const revealSensitiveContent = async () => {
        if (!currentUser || revealingSensitiveContent) return;
        if (!initialPost.sensitiveContentRestricted || initialPost.id.startsWith('swarm-repost:')) {
            setRevealedForViewerKey(viewerSensitiveAccessKey);
            setSensitiveContentRevealed(true);
            return;
        }

        setRevealingSensitiveContent(true);
        try {
            const response = await fetch(
                `/api/posts/${encodeURIComponent(initialPost.id)}?revealSensitive=1`,
                { cache: 'no-store' },
            );
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.post) {
                throw new Error(data.error || 'Sensitive post could not be loaded');
            }
            setRevealedPost(data.post as Post);
            setRevealedForViewerKey(viewerSensitiveAccessKey);
            setSensitiveContentRevealed(true);
        } catch (error) {
            showToast(error instanceof Error ? error.message : 'Sensitive post could not be loaded', 'error');
        } finally {
            setRevealingSensitiveContent(false);
        }
    };

    const sensitiveContentWarning = (
        <div
            role="note"
            style={{
                margin: '12px 16px',
                padding: '18px',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                background: 'var(--background-secondary)',
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
            }}
        >
            <TriangleAlert size={24} style={{ color: 'var(--warning)', flexShrink: 0 }} aria-hidden="true" />
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, marginBottom: '3px' }}>Sensitive content</div>
                <div style={{ color: 'var(--foreground-secondary)', fontSize: '13px', lineHeight: 1.4 }}>
                    This post was marked sensitive by its author or node.
                </div>
            </div>
            {canRevealSensitiveContent ? (
                <button
                    type="button"
                    className="btn btn-sm"
                    disabled={revealingSensitiveContent}
                    onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void revealSensitiveContent();
                    }}
                >
                    {revealingSensitiveContent ? 'Loading…' : 'Show'}
                </button>
            ) : currentUser ? (
                <Link
                    href="/settings/content"
                    className="btn btn-sm"
                    onClick={(event) => event.stopPropagation()}
                >
                    Review settings
                </Link>
            ) : (
                <Link
                    href="/login"
                    className="btn btn-sm"
                    onClick={(event) => event.stopPropagation()}
                >
                    Sign in to view
                </Link>
            )}
        </div>
    );

    // If this is a thread parent being rendered, just render the article
    if (isThreadParent) {
        return (
            <article className={`post thread-parent ${isEmbedded ? 'embedded' : ''}`}>
                <Link href={postUrl} className="post-link-overlay" aria-label="View parent post" />
                <div className="post-header">
                    <Link href={getProfilePath(authorCanonicalHandle)} className="avatar-link" onClick={(e) => e.stopPropagation()}>
                        <div className="avatar">
                            <AvatarImage avatarUrl={post.author.avatarUrl} seed={post.author.handle} nodeDomain={post.author.nodeDomain || post.nodeDomain} isNsfw={post.author.isNsfw} nodeIsNsfw={post.author.nodeIsNsfw} alt={post.author.displayName || post.author.handle} />
                        </div>
                    </Link>
                    <div className="post-author">
                        <div className="post-author-name-row">
                            <Link href={getProfilePath(authorCanonicalHandle)} className="post-handle" onClick={(e) => e.stopPropagation()}>
                                {post.author.displayName || post.author.handle}
                            </Link>
                            <StuffboxBadge badge={post.author.stuffboxBadge} linked />
                        </div>
                        <span className="post-time">{authorHandle} · {formatTime(post.createdAt)}</span>
                    </div>
                </div>
                <div className="thread-parent-body">
                    {hideSensitiveContent ? sensitiveContentWarning : (
                        <>
                            {post.content.trim() && (
                                <div className="post-content">{renderContent(post.content, embeddedVideoUrl || post.linkPreviewUrl || undefined)}</div>
                            )}
                            {renderPostMedia()}
                            {embeddedVideoUrl && <VideoEmbed url={embeddedVideoUrl} />}
                            {renderLinkPreviewCard(true)}
                        </>
                    )}
                </div>
            </article>
        );
    }

    if (isRepostEvent && post.repostOf) {
        return (
            <>
                <article ref={articleRef} className={`post repost-event ${isDetail ? 'detail' : ''} ${isEmbedded ? 'embedded' : ''}`}>
                    <div className="repost-event-header">
                        <span className="repost-event-icon" aria-hidden="true">
                            <RepeatIcon />
                        </span>
                        <span className="repost-event-text">
                            <Link href={getProfilePath(authorCanonicalHandle)} onClick={(e) => e.stopPropagation()}>
                                {post.author.displayName || post.author.handle}
                            </Link>
                            <StuffboxBadge badge={post.author.stuffboxBadge} linked />
                            <span className="repost-event-copy"> reposted</span>
                            <span className="post-time"> {repostHandle} · {formatTime(post.createdAt)}</span>
                        </span>
                    </div>

                    {hideSensitiveContent ? sensitiveContentWarning : hasOwnContent && (
                        <div className="post-content">{renderContent(post.content, embeddedVideoUrl || post.linkPreviewUrl || undefined)}</div>
                    )}

                    {!hideSensitiveContent && hasOwnContent && embeddedVideoUrl && (
                        <VideoEmbed url={embeddedVideoUrl} />
                    )}

                    <div className="repost-embed">
                        <PostCard
                            post={post.repostOf}
                            onLike={onLike}
                            onRepost={onRepost}
                            onComment={onComment}
                            onDelete={onDelete}
                            onHide={onHide}
                            isDetail={isDetail}
                            showThread={false}
                            isEmbedded={true}
                            parentPostAuthorId={parentPostAuthorId}
                        />
                    </div>
                </article>
            </>
        );
    }

    return (
        <>
            {/* Show the parent on post detail and in timelines that explicitly request reply context. */}
            {showThread && effectiveReplyTo && (isDetail || showParentContext) && (
                <div className={`thread-container ${showParentContext ? 'profile-reply-context' : ''}`}>
                    <div className="thread-line" aria-hidden="true" />
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
            <article ref={articleRef} className={`post ${isDetail ? 'detail' : ''} ${isEmbedded ? 'embedded' : ''} ${showParentContext && effectiveReplyTo ? 'thread-reply' : ''} ${showMenu ? 'menu-open' : ''}`}>
                {!isDetail && <Link href={postUrl} className="post-link-overlay" aria-label="View post" />}

                {visibleReposters.length > 0 && (
                    <div className="repost-summary">
                        <span className="repost-summary-icon" aria-hidden="true"><RepeatIcon /></span>
                        <span>Reposted by</span>
                        <span className="repost-summary-avatars">
                            {visibleReposters.map((reposter) => (
                                <Link
                                    href={getProfilePath(reposter.handle, reposter.nodeDomain || post.nodeDomain)}
                                    className="repost-summary-avatar"
                                    title={reposter.displayName || reposter.handle}
                                    aria-label={reposter.displayName || reposter.handle}
                                    key={reposter.id}
                                    onClick={(event) => event.stopPropagation()}
                                >
                                    <AvatarImage
                                        avatarUrl={reposter.avatarUrl}
                                        seed={reposter.handle}
                                        nodeDomain={reposter.nodeDomain || (isRemotePost ? post.nodeDomain : undefined)}
                                        isNsfw={reposter.isNsfw}
                                        nodeIsNsfw={reposter.nodeIsNsfw}
                                        alt=""
                                        width={22}
                                        height={22}
                                    />
                                </Link>
                            ))}
                        </span>
                        {hiddenReposters > 0 && <span>+{hiddenReposters} others</span>}
                    </div>
                )}

                <div className="post-header">
                    <Link href={getProfilePath(authorCanonicalHandle)} className="avatar-link" onClick={(e) => e.stopPropagation()}>
                        <div className="avatar">
                            <AvatarImage avatarUrl={post.author.avatarUrl} seed={post.author.handle} nodeDomain={post.author.nodeDomain || post.nodeDomain} isNsfw={post.author.isNsfw} nodeIsNsfw={post.author.nodeIsNsfw} alt={post.author.displayName || post.author.handle} />
                        </div>
                    </Link>
                    <div className="post-author">
                        <div className="post-author-name-row">
                            <Link href={getProfilePath(authorCanonicalHandle)} className="post-handle" onClick={(e) => e.stopPropagation()}>
                                {post.author.displayName || post.author.handle}
                            </Link>
                            <StuffboxBadge badge={post.author.stuffboxBadge} linked />
                        </div>
                        <span className="post-time">{authorHandle} · {formatTime(post.createdAt)}</span>
                    </div>
                    {currentUser && (
                        <div style={{ position: 'relative', marginLeft: 'auto' }}>
                            <button
                                type="button"
                                className="post-menu-btn"
                                aria-label="Post options"
                                aria-haspopup="menu"
                                aria-expanded={showMenu}
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
                                    <PostOverflowMenu
                                        onMuteUser={handleMuteUser}
                                        onBlockUser={handleBlockUser}
                                        onMuteNode={handleMuteNode}
                                        onReport={handleReport}
                                        onNotInterested={onNotInterested ? handleNotInterested : undefined}
                                        feedbackPending={feedbackPending}
                                        showMuteNode={isRemotePost && Boolean(post.nodeDomain || authorAddress?.homeDomain)}
                                        reporting={reporting}
                                        ownerMode={isOwnPost}
                                        onAddToCollection={handleAddToCollection}
                                        onDelete={handleDelete}
                                        deleting={deleting}
                                    />
                                </>
                            )}
                        </div>
                    )}
                </div>

                {effectiveReplyTo && !showThread && (
                    <div className="post-reply-to">
                        Replying to <Link href={getProfilePath(
                            effectiveReplyTo.author.handle,
                            effectiveReplyTo.author.nodeDomain || effectiveReplyTo.nodeDomain,
                        )} onClick={(e) => e.stopPropagation()}>{replyToHandle}</Link>
                    </div>
                )}

                {hideSensitiveContent ? sensitiveContentWarning : (
                    <>
                <div className="post-content">{renderContent(post.content, embeddedVideoUrl || post.linkPreviewUrl || undefined)}</div>

                {renderPostMedia()}

                {embeddedVideoUrl && (
                    <VideoEmbed url={embeddedVideoUrl} />
                )}

                {renderLinkPreviewCard()}
                    </>
                )}

                <div className="post-actions">
                    <div className="post-actions-primary">
                        <button className="post-action" onClick={handleComment} disabled={post.originUnavailable} title={post.originUnavailable ? 'Unavailable from origin' : 'Reply'}>
                            <MessageIcon />
                            <span>{post.repliesCount || ''}</span>
                        </button>
                        <button
                            className={`post-action ${reposted ? 'reposted' : ''}`}
                            onClick={handleRepost}
                            disabled={repostPending || Boolean(post.originUnavailable && !reposted)}
                            title={reposted ? 'Undo repost' : post.originUnavailable ? 'Unavailable from origin' : 'Repost'}
                        >
                            <RepeatIcon />
                            <span>{repostsCount || ''}</span>
                        </button>
                        <button className={`post-action ${liked ? 'liked' : ''}`} onClick={handleLike} disabled={post.originUnavailable || likePending} title={post.originUnavailable ? 'Unavailable from origin' : 'Like'}>
                            <HeartIcon filled={liked} />
                            <span>{likesCount || ''}</span>
                        </button>
                        {canDeletePost && !isOwnPost && (
                            <button className="post-action delete-action" onClick={handleDelete} disabled={deleting} title="Delete post">
                                <TrashIcon />
                                <span>{deleting ? '...' : ''}</span>
                            </button>
                        )}
                    </div>
                    <div className="post-actions-secondary">
                        {!hideSensitiveContent && visiblePostMedia && visiblePostMedia.length > 0 && (
                            <button className="post-action" onClick={handleDownloadMedia} disabled={downloading} title="Download media" aria-label="Download media">
                                <Download size={20} />
                            </button>
                        )}
                        <div className="post-share-control">
                            <button
                                className="post-action"
                                onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setShowShareMenu((visible) => !visible);
                                }}
                                title="Share post"
                                aria-label="Share post"
                                aria-haspopup="menu"
                                aria-expanded={showShareMenu}
                            >
                                <Share size={20} />
                            </button>
                            {showShareMenu && (
                                <>
                                    <div
                                        className="post-share-backdrop"
                                        onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            setShowShareMenu(false);
                                        }}
                                    />
                                    <div className="post-share-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                                        <button type="button" role="menuitem" onClick={handleSendViaChat}>
                                            <MessageCircle size={22} />
                                            Send in Chat
                                        </button>
                                        <button type="button" role="menuitem" onClick={handleCopyLink}>
                                            <Link2 size={22} />
                                            Copy Link
                                        </button>
                                        <button type="button" role="menuitem" onClick={handleSystemShare}>
                                            <Share size={22} />
                                            Share post via…
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </article>
            {showRecipientPicker && (
                <ChatRecipientPicker
                    currentUserHandle={currentUserHandle}
                    onClose={() => setShowRecipientPicker(false)}
                    onSelect={handleRecipientSelected}
                />
            )}
            {showCollectionPicker && isOwnPost && (
                <PostCollectionPicker
                    postId={localCollectionPostId}
                    onClose={() => setShowCollectionPicker(false)}
                    onSaved={onCollectionsChanged}
                />
            )}
        </>
    );
}
