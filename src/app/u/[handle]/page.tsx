'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { CalendarIcon, FlagIcon } from '@/components/Icons';
import { PostCard } from '@/components/PostCard';
import { User, Post } from '@/lib/types';
import AutoTextarea from '@/components/AutoTextarea';
import { UserStorageImageUpload } from '@/components/UserStorageImageUpload';
import { CollectionGrid } from '@/components/CollectionGrid';
import { Camera, Rocket, MoreHorizontal, Mail, ShieldAlert } from 'lucide-react';
import { getPostPath, getProfilePath, useFormattedHandle } from '@/lib/utils/handle';
import { useAuth } from '@/lib/contexts/AuthContext';
import { hasUnsavedChanges } from '@/lib/forms/dirty-state';
import { signedAPI } from '@/lib/api/signed-fetch';
import { AvatarImage } from '@/components/AvatarImage';
import { ProfileBanner } from '@/components/ProfileBanner';
import { useAppDialog } from '@/lib/contexts/DialogContext';
import { decodeAccountRouteSegment } from '@/lib/navigation/route-params';
import { useDomain } from '@/lib/contexts/ConfigContext';
import { displayAccountAddress, sameAccountAddress } from '@/lib/identity/account-address';
import { StuffboxBadge } from '@/components/StuffboxBadge';
import type { StuffboxBadge as StuffboxBadgeValue } from '@/lib/types';
import {
    buildProfileDocumentData,
    PUBLISH_PROFILE_ACTION,
} from '@/lib/profile/profile-document';
import { useProfilePresentationRegistry } from '@/lib/contexts/ProfilePresentationContext';

interface UserSummary {
    id: string;
    handle: string;
    displayName?: string | null;
    bio?: string | null;
    avatarUrl?: string | null;
    isNsfw?: boolean;
    nodeIsNsfw?: boolean;
    nodeDomain?: string | null;
    stuffboxBadge?: StuffboxBadgeValue | null;
}

type ProfileMediaField = 'avatarUrl' | 'headerUrl';

// Strip HTML tags from a string
const stripHtml = (html: string | null | undefined): string | null => {
    if (!html) return null;
    return html.replace(/<[^>]*>/g, '').trim() || null;
};

function UserRow({ user }: { user: UserSummary }) {
    const fullHandle = useFormattedHandle(user.handle);
    return (
        <Link href={getProfilePath(user.handle, user.nodeDomain)} className="user-row">
            <div className="avatar">
                <AvatarImage avatarUrl={user.avatarUrl} seed={user.handle} nodeDomain={user.nodeDomain} isNsfw={user.isNsfw} nodeIsNsfw={user.nodeIsNsfw} alt={user.displayName || user.handle} />
            </div>
            <div className="user-row-content">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontWeight: 600 }}>
                    {user.displayName || user.handle}
                    <StuffboxBadge badge={user.stuffboxBadge} />
                </span>
                <div style={{ color: 'var(--foreground-tertiary)', fontSize: '13px' }}>{fullHandle}</div>
                {user.bio && stripHtml(user.bio) && (
                    <div className="user-row-bio">{stripHtml(user.bio)}</div>
                )}
            </div>
        </Link>
    );
}

export default function ProfilePage() {
    const params = useParams();
    const router = useRouter();
    const searchParams = useSearchParams();
    const domain = useDomain();
    const handle = decodeAccountRouteSegment(params.handle as string | undefined, domain) || '';
    const userApiPath = `/api/users/${encodeURIComponent(handle)}`;
    const {
        user: authenticatedViewer,
        loading: authLoading,
        isIdentityUnlocked,
        isRestoring,
        did,
        handle: currentHandle,
        signUserAction,
        updateUserProfile,
    } = useAuth();
    const { publishVerifiedPresentation } = useProfilePresentationRegistry();
    const { showAlert, showPrompt } = useAppDialog();

    const [user, setUser] = useState<User | null>(null);
    const userFullHandle = useFormattedHandle(user?.handle || '');
    const [posts, setPosts] = useState<Post[]>([]);
    const [likedPosts, setLikedPosts] = useState<Post[]>([]);
    const [isFollowing, setIsFollowing] = useState(false);
    const [followStatusLoading, setFollowStatusLoading] = useState(true);
    const [followPending, setFollowPending] = useState(false);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<'posts' | 'collections' | 'replies' | 'likes' | 'followers' | 'following'>(
        searchParams.get('tab') === 'collections' ? 'collections' : 'posts',
    );
    const [followers, setFollowers] = useState<UserSummary[]>([]);
    const [following, setFollowing] = useState<UserSummary[]>([]);
    const [repliesPosts, setRepliesPosts] = useState<Post[]>([]);
    const [postsLoading, setPostsLoading] = useState(true);
    const [likesLoading, setLikesLoading] = useState(false);
    const [repliesLoading, setRepliesLoading] = useState(false);
    const [followersLoading, setFollowersLoading] = useState(false);
    const [followingLoading, setFollowingLoading] = useState(false);
    const [postsLoadingMore, setPostsLoadingMore] = useState(false);
    const [repliesLoadingMore, setRepliesLoadingMore] = useState(false);
    const [postsCursor, setPostsCursor] = useState<string | null>(null);
    const [repliesCursor, setRepliesCursor] = useState<string | null>(null);
    const [isEditing, setIsEditing] = useState(false);
    const [profileForm, setProfileForm] = useState({
        displayName: '',
        bio: '',
        avatarUrl: '',
        headerUrl: '',
        website: '',
    });
    const [saveError, setSaveError] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [mediaSaveStatus, setMediaSaveStatus] = useState<Partial<Record<ProfileMediaField, 'saving' | 'saved'>>>({});
    const savedProfileForm = user ? {
        displayName: user.displayName || '',
        bio: user.bio || '',
        avatarUrl: user.avatarUrl || '',
        headerUrl: user.headerUrl || '',
        website: user.website || '',
    } : null;
    const profileChanged = hasUnsavedChanges(profileForm, savedProfileForm);
    const isSavingProfileMedia = Object.values(mediaSaveStatus).includes('saving');
    const [isBlocked, setIsBlocked] = useState(false);
    const [showMenu, setShowMenu] = useState(false);
    const [reporting, setReporting] = useState(false);
    useEffect(() => {
        setIsEditing(false);
        setSaveError(null);
        setFollowers([]);
        setFollowing([]);
        setLikedPosts([]);
        setRepliesPosts([]);
        setFollowStatusLoading(true);
        setFollowPending(false);
        setShowMenu(false);
        setReporting(false);

        // Get profile
        fetch(userApiPath)
            .then(res => res.json())
            .then(data => {
                setUser(data.user);
                publishVerifiedPresentation(data.user);
                setLoading(false);
            })
            .catch(() => setLoading(false));

        setPostsLoading(true);
        setPostsCursor(null);
        setRepliesCursor(null);
        fetch(`${userApiPath}/posts`)
            .then(res => res.json())
            .then(data => {
                setPosts(data.posts || []);
                setPostsCursor(data.nextCursor || null);
            })
            .catch(() => { })
            .finally(() => setPostsLoading(false));
    }, [handle, publishVerifiedPresentation, userApiPath]);

    // Infinite scroll ref
    const loadMoreRef = useRef<HTMLDivElement>(null);

    // Load more posts
    const loadMorePosts = useCallback(async () => {
        if (!postsCursor || postsLoadingMore) return;
        setPostsLoadingMore(true);
        try {
            const res = await fetch(`${userApiPath}/posts?cursor=${encodeURIComponent(postsCursor)}`);
            const data = await res.json();
            setPosts(prev => [...prev, ...(data.posts || [])]);
            setPostsCursor(data.nextCursor || null);
        } catch {
            // ignore
        } finally {
            setPostsLoadingMore(false);
        }
    }, [postsCursor, postsLoadingMore, userApiPath]);

    // Load more replies
    const loadMoreReplies = useCallback(async () => {
        if (!repliesCursor || repliesLoadingMore || !user) return;
        setRepliesLoadingMore(true);
        try {
            const res = await fetch(`${userApiPath}/replies?cursor=${encodeURIComponent(repliesCursor)}`);
            const data = await res.json();
            setRepliesPosts(prev => [...prev, ...(data.posts || [])]);
            setRepliesCursor(data.nextCursor || null);
        } catch {
            // ignore
        } finally {
            setRepliesLoadingMore(false);
        }
    }, [user, repliesCursor, repliesLoadingMore, userApiPath]);

    // Infinite scroll observer
    useEffect(() => {
        if (!loadMoreRef.current) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting) {
                    if (activeTab === 'posts' && postsCursor && !postsLoadingMore) {
                        loadMorePosts();
                    } else if (activeTab === 'replies' && repliesCursor && !repliesLoadingMore) {
                        loadMoreReplies();
                    }
                }
            },
            { threshold: 0.1 }
        );

        observer.observe(loadMoreRef.current);
        return () => observer.disconnect();
    }, [activeTab, postsCursor, repliesCursor, postsLoadingMore, repliesLoadingMore, loadMorePosts, loadMoreReplies]);

    const handleLike = async (postId: string, currentLiked: boolean) => {
        if (!did || !currentHandle) {
            throw new Error('Please log in again.');
        }

        const res = currentLiked
            ? await signedAPI.unlikePost(postId, did, currentHandle)
            : await signedAPI.likePost(postId, did, currentHandle);

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Failed to update like');
        }
    };

    const handleRepost = async (postId: string, currentReposted: boolean) => {
        if (!did || !currentHandle) {
            throw new Error('Please log in again.');
        }

        const res = currentReposted
            ? await signedAPI.unrepostPost(postId, did, currentHandle)
            : await signedAPI.repostPost(postId, did, currentHandle);

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Failed to update repost');
        }

        if (currentReposted && authenticatedViewer) {
            const ownRepostEvent = posts.find((post) => (
                (post.repostOf?.id === postId || post.repostOfId === postId)
                && post.author.id === authenticatedViewer.id
            ));
            if (ownRepostEvent) {
                setPosts((currentPosts) => currentPosts.filter((post) => post.id !== ownRepostEvent.id));
                setUser((currentUser) => currentUser ? {
                    ...currentUser,
                    postsCount: Math.max(0, (currentUser.postsCount || 0) - 1),
                } : currentUser);
            }
        }
    };

    const handleComment = (post: Post) => {
        // Navigation is handled by the PostCard overlay, 
        // but we can also use router.push if they explicitly click the comment button.
        router.push(getPostPath(post.author.handle, post.id, post.author.nodeDomain || post.nodeDomain));
    };

    const handleDelete = (postId: string) => {
        setPosts(prev => prev.filter(p => p.id !== postId));
        setRepliesPosts(prev => prev.filter(p => p.id !== postId));
        if (user && isOwnProfile) {
            setUser({
                ...user,
                postsCount: (user.postsCount || 0) - 1
            });
        }
    };

    useEffect(() => {
        if (user && authenticatedViewer && sameAccountAddress(authenticatedViewer.handle, user.handle) && !isEditing) {
            setProfileForm({
                displayName: user.displayName || '',
                bio: user.bio || '',
                avatarUrl: user.avatarUrl || '',
                headerUrl: user.headerUrl || '',
                website: user.website || '',
            });
        }
    }, [user, authenticatedViewer, isEditing]);

    useEffect(() => {
        let cancelled = false;

        if (!authenticatedViewer || !user || sameAccountAddress(authenticatedViewer.handle, user.handle)) {
            setIsFollowing(false);
            setFollowStatusLoading(false);
            setIsBlocked(false);
            return;
        }

        setFollowStatusLoading(true);
        fetch(`${userApiPath}/follow`)
            .then(res => {
                if (!res.ok) throw new Error('Failed to load follow status');
                return res.json();
            })
            .then(data => {
                if (!cancelled) setIsFollowing(!!data.following);
            })
            .catch(() => {
                if (!cancelled) setIsFollowing(false);
            })
            .finally(() => {
                if (!cancelled) setFollowStatusLoading(false);
            });

        fetch(`${userApiPath}/block`)
            .then(res => res.json())
            .then(data => {
                if (!cancelled) setIsBlocked(!!data.blocked);
            })
            .catch(() => {
                if (!cancelled) setIsBlocked(false);
            });

        return () => {
            cancelled = true;
        };
    }, [authenticatedViewer, user, userApiPath]);

    useEffect(() => {
        if (activeTab === 'followers') {
            setFollowersLoading(true);
            fetch(`${userApiPath}/followers`)
                .then(res => res.json())
                .then(data => setFollowers(data.followers || []))
                .catch(() => setFollowers([]))
                .finally(() => setFollowersLoading(false));
        }

        if (activeTab === 'following') {
            setFollowingLoading(true);
            fetch(`${userApiPath}/following`)
                .then(res => res.json())
                .then(data => setFollowing(data.following || []))
                .catch(() => setFollowing([]))
                .finally(() => setFollowingLoading(false));
        }

        if (activeTab === 'likes') {
            setLikesLoading(true);
            fetch(`${userApiPath}/likes`)
                .then(res => res.json())
                .then(data => setLikedPosts(data.posts || []))
                .catch(() => setLikedPosts([]))
                .finally(() => setLikesLoading(false));
        }

        if (activeTab === 'replies' && user) {
            setRepliesLoading(true);
            setRepliesCursor(null);
            fetch(`${userApiPath}/replies`)
                .then(res => res.json())
                .then(data => {
                    setRepliesPosts(data.posts || []);
                    setRepliesCursor(data.nextCursor || null);
                })
                .catch(() => setRepliesPosts([]))
                .finally(() => setRepliesLoading(false));
        }
    }, [activeTab, user, userApiPath]);

    const handleFollow = async () => {
        if (!authenticatedViewer || authLoading || isRestoring || followStatusLoading || followPending) return;

        if (!isIdentityUnlocked) {
            await showAlert({
                title: 'Session expired',
                message: 'Please log in again before following this user.',
            });
            return;
        }

        if (!did || !currentHandle) {
            await showAlert({
                title: 'Session expired',
                message: 'Please log in again before following this user.',
            });
            return;
        }

        const wasFollowing = isFollowing;
        setFollowPending(true);

        try {
            const res = wasFollowing
                ? await signedAPI.unfollowUser(handle, did, currentHandle)
                : await signedAPI.followUser(handle, did, currentHandle);
            const data = await res.json().catch(() => ({})) as {
                error?: string;
                following?: boolean;
                changed?: boolean;
            };

            if (!res.ok) {
                throw new Error(data.error || (wasFollowing ? 'Failed to unfollow user' : 'Failed to follow user'));
            }

            const nextFollowing = typeof data.following === 'boolean'
                ? data.following
                : !wasFollowing;
            setIsFollowing(nextFollowing);

            const relationshipChanged = data.changed ?? (nextFollowing !== wasFollowing);
            if (relationshipChanged && nextFollowing !== wasFollowing) {
                setUser(current => current ? {
                    ...current,
                    followersCount: nextFollowing
                        ? (current.followersCount || 0) + 1
                        : Math.max(0, (current.followersCount || 0) - 1),
                } : current);
            }
        } catch (error) {
            await showAlert({
                title: wasFollowing ? 'Unfollow failed' : 'Follow failed',
                message: error instanceof Error
                    ? error.message
                    : 'Please try again.',
            });
        } finally {
            setFollowPending(false);
        }
    };

    const handleBlock = async () => {
        if (!authenticatedViewer) return;

        if (!isIdentityUnlocked) {
            await showAlert({
                title: 'Session expired',
                message: 'Please log in again before changing block settings.',
            });
            return;
        }

        const method = isBlocked ? 'DELETE' : 'POST';
        const res = await fetch(`${userApiPath}/block`, { method });

        if (res.ok) {
            setIsBlocked(!isBlocked);
            if (!isBlocked) {
                // If blocking, also unfollow
                setIsFollowing(false);
            }
            setShowMenu(false);
        }
    };

    const handleReport = async () => {
        if (!authenticatedViewer || !user || reporting) return;

        if (!isIdentityUnlocked || !did || !currentHandle) {
            setShowMenu(false);
            await showAlert({
                title: 'Session expired',
                message: 'Please log in again before reporting this user.',
            });
            return;
        }

        const reason = await showPrompt({
            title: 'Report user',
            message: `Tell the moderation team what is wrong with ${displayAccountAddress(user.handle)}.`,
            inputLabel: 'Reason for reporting',
            placeholder: 'Describe the issue',
            confirmLabel: 'Submit report',
            required: true,
        });
        const trimmedReason = reason?.trim() || '';

        if (!trimmedReason) {
            setShowMenu(false);
            return;
        }
        if (trimmedReason.length < 3 || trimmedReason.length > 500) {
            setShowMenu(false);
            await showAlert({
                title: 'Report not submitted',
                message: 'The report reason must be between 3 and 500 characters.',
            });
            return;
        }

        setReporting(true);
        try {
            // Remote profile IDs are view-local synthetic values. Their canonical
            // account address is the durable target understood by this node.
            const targetId = user.isRemote || user.isSwarm ? user.handle : user.id;
            const res = await signedAPI.report(
                'user',
                targetId,
                trimmedReason,
                did,
                currentHandle,
            );
            const data = await res.json().catch(() => null) as { error?: string } | null;
            setShowMenu(false);

            if (!res.ok) {
                await showAlert({
                    title: 'Report failed',
                    message: data?.error || 'The report could not be submitted. Please try again.',
                    tone: 'danger',
                });
                return;
            }

            await showAlert({
                title: 'Report submitted',
                message: 'Thank you. The moderation team can now review this user.',
            });
        } catch (error) {
            setShowMenu(false);
            await showAlert({
                title: 'Report failed',
                message: error instanceof Error
                    ? error.message
                    : 'The report could not be submitted. Please try again.',
                tone: 'danger',
            });
        } finally {
            setReporting(false);
        }
    };

    const updateProfile = async (presentation: typeof profileForm): Promise<User> => {
            const signedPayload = await signUserAction(
                PUBLISH_PROFILE_ACTION,
                buildProfileDocumentData(presentation),
            );

            const res = await fetch('/api/auth/me', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(signedPayload),
            });

            const data = await res.json() as { error?: string; user?: User };

            if (!res.ok || !data.user) {
                throw new Error(data.error || 'Failed to update profile');
            }

            return data.user;
    };

    const handleSaveProfile = async () => {
        if (!isOwnProfile || !profileChanged) return;

        if (!isIdentityUnlocked) {
            setSaveError('Session expired. Please log in again.');
            return;
        }

        setIsSaving(true);
        setSaveError(null);

        try {
            const updatedUser = await updateProfile(profileForm);

            setUser(prev => prev ? { ...prev, ...updatedUser } : updatedUser);
            updateUserProfile(updatedUser);
            setIsEditing(false);
        } catch (error) {
            console.error('Profile update failed', error);
            setSaveError(error instanceof Error ? error.message : 'Unable to update profile. Please try again.');
        } finally {
            setIsSaving(false);
        }
    };

    const handleProfileMediaChange = async (field: ProfileMediaField, value: string) => {
        setProfileForm(prev => ({ ...prev, [field]: value }));
        setSaveError(null);

        if (!isOwnProfile || !isIdentityUnlocked) {
            setSaveError('Session expired. Please log in again.');
            return;
        }

        setMediaSaveStatus(prev => ({ ...prev, [field]: 'saving' }));
        try {
            const updatedUser = await updateProfile({ ...profileForm, [field]: value });
            setUser(prev => prev ? { ...prev, ...updatedUser } : updatedUser);
            updateUserProfile(updatedUser);
            setMediaSaveStatus(prev => ({ ...prev, [field]: 'saved' }));
            window.setTimeout(() => {
                setMediaSaveStatus(prev => prev[field] === 'saved' ? { ...prev, [field]: undefined } : prev);
            }, 2000);
        } catch (error) {
            console.error('Profile media update failed', error);
            setMediaSaveStatus(prev => ({ ...prev, [field]: undefined }));
            setSaveError(error instanceof Error ? error.message : 'Unable to save profile media. Please try again.');
        }
    };

    const formatDate = (dateStr: string) => {
        return new Date(dateStr).toLocaleDateString('en-US', {
            month: 'long',
            year: 'numeric',
        });
    };

    if (loading) {
        return (
            <div style={{
                minHeight: '100vh',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--foreground-tertiary)',
            }}>
                Loading...
            </div>
        );
    }

    if (!user) {
        return (
            <div style={{
                minHeight: '100vh',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '16px',
            }}>
                <h1 style={{ fontSize: '24px', fontWeight: 600 }}>User not found</h1>
                <Link href="/" className="btn btn-primary">Go home</Link>
            </div>
        );
    }

    if (user.nsfwRestricted) {
        const settingsPath = authenticatedViewer ? '/settings/content' : '/login';
        const actionLabel = authenticatedViewer ? 'Open content settings' : 'Sign in to continue';

        return (
            <div style={{ maxWidth: '600px', margin: '0 auto', minHeight: '100vh' }}>
                <header style={{
                    padding: '16px',
                    borderBottom: '1px solid var(--border)',
                }}>
                    <h1 style={{ fontSize: '18px', fontWeight: 600 }}>{displayAccountAddress(user.handle)}</h1>
                </header>
                <div style={{ padding: '48px 24px' }}>
                    <div className="card" style={{ padding: '28px', textAlign: 'center' }}>
                        <ShieldAlert size={36} style={{ color: 'var(--warning)', margin: '0 auto 14px' }} aria-hidden="true" />
                        <h2 style={{ fontSize: '20px', fontWeight: 700, marginBottom: '10px' }}>
                            Sensitive profile hidden
                        </h2>
                        <p style={{ color: 'var(--foreground-secondary)', lineHeight: 1.5, marginBottom: '20px' }}>
                            This account is marked NSFW or belongs to an adult-only node. Its profile details and posts are hidden until you explicitly enable NSFW viewing.
                        </p>
                        <Link href={settingsPath} className="btn btn-primary">
                            {actionLabel}
                        </Link>
                    </div>
                </div>
            </div>
        );
    }

    const isOwnProfile = Boolean(authenticatedViewer
        && sameAccountAddress(authenticatedViewer.handle, user.handle));
    const followUnavailable = authLoading || isRestoring || followStatusLoading || followPending;
    const visibleTabs = ['posts', 'replies', 'likes', 'collections', 'followers', 'following'] as const;

    return (
        <div style={{ maxWidth: '600px', margin: '0 auto', minHeight: '100vh' }}>
            {/* Header */}
            <header style={{
                padding: '16px',
                display: 'flex',
                alignItems: 'center',
                borderBottom: '1px solid var(--border)',
                position: 'sticky',
                top: 0,
                background: 'var(--background)',
                zIndex: 10,
            }}>
                <div>
                    <h1 style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '18px', fontWeight: 600 }}>
                        {user.displayName || user.handle}
                        <StuffboxBadge badge={user.stuffboxBadge} linked />
                    </h1>
                    <p style={{ fontSize: '13px', color: 'var(--foreground-tertiary)' }}>{user.postsCount} posts</p>
                </div>
            </header>

            {/* Account Moved Banner */}
            {user.movedTo && (
                <div style={{
                    padding: '16px',
                    background: 'rgba(245, 158, 11, 0.1)',
                    borderBottom: '1px solid rgba(245, 158, 11, 0.3)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                }}>
                    <Rocket size={24} style={{ color: 'var(--warning)' }} />
                    <div>
                        <div style={{ fontWeight: 600, color: 'var(--warning)', marginBottom: '4px' }}>
                            This account has moved
                        </div>
                        <div style={{ fontSize: '14px', color: 'var(--foreground-secondary)' }}>
                            This user has migrated to a new node:{' '}
                            <a
                                href={user.movedTo}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ color: 'var(--accent)' }}
                            >
                                {user.movedTo.replace('https://', '').replace('/api/users/', '/@').replace('/users/', '/@')}
                            </a>
                        </div>
                    </div>
                </div>
            )}

            {/* Profile Header */}
            <div style={{ borderBottom: '1px solid var(--border)' }}>
                {/* Banner */}
                {isEditing ? (
                    <UserStorageImageUpload
                        label="Profile banner"
                        value={profileForm.headerUrl}
                        onChange={(headerUrl) => {
                            void handleProfileMediaChange('headerUrl', headerUrl);
                        }}
                        onError={(message) => setSaveError(message || null)}
                        renderTrigger={({ chooseFile, isUploading }) => {
                            const isBusy = isUploading || mediaSaveStatus.headerUrl === 'saving';
                            return (
                                <div style={{ position: 'relative' }}>
                                    <ProfileBanner
                                        url={profileForm.headerUrl}
                                        accountHandle={user.handle}
                                        isRemote={user.isRemote}
                                        nodeDomain={user.nodeDomain}
                                        isNsfw={user.isNsfw}
                                        nodeIsNsfw={user.nodeIsNsfw}
                                        aspectRatio="3 / 1"
                                    />
                                    <button
                                        type="button"
                                        aria-label="Change profile banner"
                                        aria-busy={isBusy}
                                        disabled={isBusy}
                                        onClick={chooseFile}
                                        style={{
                                            position: 'absolute',
                                            inset: 0,
                                            width: '100%',
                                            border: 0,
                                            background: 'rgba(0, 0, 0, 0.3)',
                                            color: '#fff',
                                            cursor: isBusy ? 'wait' : 'pointer',
                                            display: 'flex',
                                            flexDirection: 'column',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            gap: '8px',
                                        }}
                                    >
                                        <span style={{
                                            width: '44px',
                                            height: '44px',
                                            borderRadius: '50%',
                                            display: 'grid',
                                            placeItems: 'center',
                                            background: 'rgba(0, 0, 0, 0.72)',
                                        }}>
                                            <Camera size={22} aria-hidden="true" />
                                        </span>
                                        {isBusy && <span style={{ fontSize: '13px', fontWeight: 600 }}>Uploading…</span>}
                                    </button>
                                </div>
                            );
                        }}
                    />
                ) : (
                    <ProfileBanner
                        url={user.headerUrl}
                        accountHandle={user.handle}
                        isRemote={user.isRemote}
                        nodeDomain={user.nodeDomain}
                        isNsfw={user.isNsfw}
                        nodeIsNsfw={user.nodeIsNsfw}
                        aspectRatio="3 / 1"
                    />
                )}

                {/* Avatar & Actions */}
                <div style={{ padding: '0 16px' }}>
                    <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                    }}>
                        {isEditing ? (
                            <UserStorageImageUpload
                                label="Profile photo"
                                value={profileForm.avatarUrl}
                                onChange={(avatarUrl) => {
                                    void handleProfileMediaChange('avatarUrl', avatarUrl);
                                }}
                                onError={(message) => setSaveError(message || null)}
                                renderTrigger={({ chooseFile, isUploading }) => {
                                    const isBusy = isUploading || mediaSaveStatus.avatarUrl === 'saving';
                                    return (
                                        <div
                                            className="avatar avatar-lg"
                                            style={{
                                                width: '96px',
                                                height: '96px',
                                                fontSize: '36px',
                                                border: '4px solid var(--background)',
                                                marginTop: '-48px',
                                                position: 'relative',
                                            }}
                                        >
                                            <AvatarImage avatarUrl={profileForm.avatarUrl} seed={user.handle} nodeDomain={user.nodeDomain} isNsfw={user.isNsfw} nodeIsNsfw={user.nodeIsNsfw} alt={user.displayName || user.handle} />
                                            <button
                                                type="button"
                                                aria-label="Change profile photo"
                                                aria-busy={isBusy}
                                                disabled={isBusy}
                                                onClick={chooseFile}
                                                style={{
                                                    position: 'absolute',
                                                    inset: 0,
                                                    width: '100%',
                                                    height: '100%',
                                                    border: 0,
                                                    borderRadius: '50%',
                                                    background: 'rgba(0, 0, 0, 0.42)',
                                                    color: '#fff',
                                                    cursor: isBusy ? 'wait' : 'pointer',
                                                    display: 'grid',
                                                    placeItems: 'center',
                                                }}
                                            >
                                                <Camera size={24} aria-hidden="true" />
                                            </button>
                                        </div>
                                    );
                                }}
                            />
                        ) : (
                            <div
                                className="avatar avatar-lg"
                                style={{
                                    width: '96px',
                                    height: '96px',
                                    fontSize: '36px',
                                    border: '4px solid var(--background)',
                                    marginTop: '-48px',
                                    position: 'relative',
                                }}
                            >
                                <AvatarImage avatarUrl={user.avatarUrl} seed={user.handle} nodeDomain={user.nodeDomain} isNsfw={user.isNsfw} nodeIsNsfw={user.nodeIsNsfw} alt={user.displayName || user.handle} />
                            </div>
                        )}

                        <div style={{ paddingTop: '12px', display: 'flex', gap: '8px', alignItems: 'center' }}>
                            {!isOwnProfile && authenticatedViewer && (
                                <>
                                    {!isBlocked && (
                                        <button
                                            className={`btn ${isFollowing ? '' : 'btn-primary'}`}
                                            onClick={handleFollow}
                                            disabled={followUnavailable}
                                            aria-busy={followPending}
                                        >
                                            {followStatusLoading
                                                ? 'Loading…'
                                                : followPending
                                                    ? (isFollowing ? 'Unfollowing…' : 'Following…')
                                                    : (isFollowing ? 'Following' : 'Follow')}
                                        </button>
                                    )}
                                    {/* Message Button (V2 Chat) - Respect privacy settings */}
                                    {user.did && user.canReceiveDms !== false && (
                                        <Link href={`/chat?compose=${user.handle}`} className="btn btn-ghost" style={{ padding: '8px' }}>
                                            <Mail size={20} />
                                        </Link>
                                    )}
                                    <div style={{ position: 'relative' }}>
                                        <button
                                            type="button"
                                            className="btn btn-ghost"
                                            onClick={() => setShowMenu(!showMenu)}
                                            style={{ padding: '8px' }}
                                            aria-label="Profile options"
                                            aria-haspopup="menu"
                                            aria-expanded={showMenu}
                                        >
                                            <MoreHorizontal size={20} />
                                        </button>
                                        {showMenu && (
                                            <>
                                                <div
                                                    style={{
                                                        position: 'fixed',
                                                        inset: 0,
                                                        zIndex: 99,
                                                    }}
                                                    onClick={() => setShowMenu(false)}
                                                />
                                                <div role="menu" aria-label="Profile options" style={{
                                                    position: 'absolute',
                                                    right: 0,
                                                    top: '100%',
                                                    marginTop: '4px',
                                                    background: 'var(--background-secondary)',
                                                    border: '1px solid var(--border)',
                                                    borderRadius: 'var(--radius-md)',
                                                    minWidth: '160px',
                                                    zIndex: 100,
                                                    overflow: 'hidden',
                                                }}>
                                                    <button
                                                        type="button"
                                                        role="menuitem"
                                                        onClick={handleBlock}
                                                        style={{
                                                            width: '100%',
                                                            padding: '12px 16px',
                                                            background: 'none',
                                                            border: 'none',
                                                            textAlign: 'left',
                                                            cursor: 'pointer',
                                                            color: isBlocked ? 'var(--foreground)' : 'var(--error)',
                                                            fontSize: '14px',
                                                        }}
                                                    >
                                                        {isBlocked ? 'Unblock user' : 'Block user'}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        role="menuitem"
                                                        onClick={handleReport}
                                                        disabled={reporting}
                                                        aria-busy={reporting}
                                                        style={{
                                                            width: '100%',
                                                            padding: '12px 16px',
                                                            background: 'none',
                                                            border: 'none',
                                                            borderTop: '1px solid var(--border)',
                                                            textAlign: 'left',
                                                            cursor: reporting ? 'default' : 'pointer',
                                                            color: 'var(--error)',
                                                            fontSize: '14px',
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            gap: '10px',
                                                            opacity: reporting ? 0.65 : 1,
                                                        }}
                                                    >
                                                        <FlagIcon />
                                                        {reporting ? 'Reporting…' : 'Report user'}
                                                    </button>
                                                </div>
                                            </>
                                        )}
                                    </div>
                                </>
                            )}

                            {isOwnProfile && (
                                <button className="btn" onClick={() => setIsEditing(!isEditing)}>
                                    {isEditing ? 'Close' : 'Edit Profile'}
                                </button>
                            )}
                        </div>
                    </div>

                    {/* User Info */}
                    <div style={{ padding: '12px 0' }}>
                        <h2 style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '20px', fontWeight: 700 }}>
                            {user.displayName || user.handle}
                            <StuffboxBadge badge={user.stuffboxBadge} linked />
                        </h2>
                        <p style={{ color: 'var(--foreground-tertiary)' }}>{userFullHandle}</p>

                        {user.bio && (
                            <p style={{ marginTop: '12px', lineHeight: 1.5 }}>{user.bio}</p>
                        )}

                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '16px',
                            marginTop: '12px',
                            color: 'var(--foreground-tertiary)',
                            fontSize: '14px',
                            whiteSpace: 'nowrap',
                            overflowX: 'auto',
                            scrollbarWidth: 'none',
                        }}>
                            <span style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '6px',
                                flexShrink: 0,
                            }}>
                                <CalendarIcon />
                                Joined {formatDate(user.createdAt || new Date().toISOString())}
                            </span>

                            {user.website && (
                                <Link
                                    href={user.website.startsWith('http') ? user.website : `https://${user.website}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{ color: 'var(--accent)', textDecoration: 'none', flexShrink: 0 }}
                                >
                                    {user.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}
                                </Link>
                            )}

                            <button
                                onClick={() => setActiveTab('followers')}
                                style={{
                                    background: 'none',
                                    border: 'none',
                                    padding: 0,
                                    color: 'var(--foreground)',
                                    cursor: 'pointer',
                                    font: 'inherit',
                                    flexShrink: 0,
                                }}
                            >
                                <strong>{user.followersCount}</strong>{' '}
                                <span style={{ color: 'var(--foreground-tertiary)' }}>Followers</span>
                            </button>
                            <button
                                onClick={() => setActiveTab('following')}
                                style={{
                                    background: 'none',
                                    border: 'none',
                                    padding: 0,
                                    color: 'var(--foreground)',
                                    cursor: 'pointer',
                                    font: 'inherit',
                                    flexShrink: 0,
                                }}
                            >
                                <strong>{user.followingCount}</strong>{' '}
                                <span style={{ color: 'var(--foreground-tertiary)' }}>Following</span>
                            </button>
                        </div>
                    </div>
                </div>

                {isOwnProfile && isEditing && (
                    <div style={{ padding: '0 16px 16px' }}>
                        <div className="card" style={{ padding: '16px' }}>
                            <div style={{ fontWeight: 600, marginBottom: '12px' }}>Edit profile</div>
                            <div style={{ display: 'grid', gap: '12px' }}>
                                <div>
                                    <label style={{ fontSize: '12px', color: 'var(--foreground-tertiary)' }}>Display name</label>
                                    <input
                                        className="input"
                                        value={profileForm.displayName}
                                        onChange={(e) => setProfileForm({ ...profileForm, displayName: e.target.value })}
                                        maxLength={50}
                                    />
                                </div>
                                <div>
                                    <label style={{ fontSize: '12px', color: 'var(--foreground-tertiary)' }}>Bio</label>
                                    <AutoTextarea
                                        className="input"
                                        value={profileForm.bio}
                                        onChange={(e) => setProfileForm({ ...profileForm, bio: e.target.value })}
                                        maxLength={160}
                                        style={{ minHeight: '80px', resize: 'vertical' }}
                                    />
                                </div>
                                <div>
                                    <label style={{ fontSize: '12px', color: 'var(--foreground-tertiary)' }}>Website</label>
                                    <input
                                        className="input"
                                        placeholder="https://example.com"
                                        value={profileForm.website}
                                        onChange={(e) => setProfileForm({ ...profileForm, website: e.target.value })}
                                        maxLength={100}
                                    />
                                </div>
                                {(profileForm.avatarUrl || profileForm.headerUrl) && (
                                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                                        {profileForm.avatarUrl && (
                                            <button
                                                type="button"
                                                className="btn btn-ghost btn-sm"
                                                style={{ color: 'var(--foreground-tertiary)' }}
                                                disabled={isSavingProfileMedia}
                                                onClick={() => void handleProfileMediaChange('avatarUrl', '')}
                                            >
                                                Remove profile photo
                                            </button>
                                        )}
                                        {profileForm.headerUrl && (
                                            <button
                                                type="button"
                                                className="btn btn-ghost btn-sm"
                                                style={{ color: 'var(--foreground-tertiary)' }}
                                                disabled={isSavingProfileMedia}
                                                onClick={() => void handleProfileMediaChange('headerUrl', '')}
                                            >
                                                Remove banner
                                            </button>
                                        )}
                                    </div>
                                )}
                                {saveError && (
                                    <div style={{ color: 'var(--error)', fontSize: '13px' }}>{saveError}</div>
                                )}
                                <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '8px' }}>
                                    <button className="btn btn-ghost" onClick={() => setIsEditing(false)} disabled={isSaving}>
                                        Cancel
                                    </button>
                                    <button className="btn btn-primary" onClick={handleSaveProfile} disabled={isSaving || isSavingProfileMedia || !profileChanged}>
                                        {isSaving ? 'Saving...' : 'Save'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Tabs */}
                <div style={{ display: 'flex', borderTop: '1px solid var(--border)', overflowX: 'auto' }}>
                    {visibleTabs.map(tab => (
                        <button
                            key={tab}
                            onClick={() => setActiveTab(tab)}
                            style={{
                                flex: 1,
                                minWidth: 'max-content',
                                padding: '16px 12px',
                                background: 'none',
                                border: 'none',
                                borderBottom: activeTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
                                color: activeTab === tab ? 'var(--foreground)' : 'var(--foreground-tertiary)',
                                fontWeight: activeTab === tab ? 600 : 400,
                                cursor: 'pointer',
                                textTransform: 'capitalize',
                            }}
                        >
                            {tab}
                        </button>
                    ))}
                </div>
            </div>

            {/* Content */}
            {activeTab === 'posts' && (
                postsLoading ? (
                    <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>
                        <p>Loading...</p>
                    </div>
                ) : posts.length === 0 ? (
                    <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>
                        <p>No posts yet</p>
                    </div>
                ) : (
                    <>
                        {posts.map((post, index) => (
                            <PostCard
                                key={`${post.id}-${index}`}
                                post={post}
                                onLike={handleLike}
                                onRepost={handleRepost}
                                onComment={handleComment}
                                onDelete={handleDelete}
                            />
                        ))}
                        <div ref={loadMoreRef} style={{ padding: '24px', textAlign: 'center' }}>
                            {postsLoadingMore && (
                                <span style={{ color: 'var(--foreground-tertiary)' }}>Loading more...</span>
                            )}
                        </div>
                    </>
                )
            )}

            {activeTab === 'collections' && (
                <CollectionGrid handle={handle} />
            )}

            {activeTab === 'replies' && (
                repliesLoading ? (
                    <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>
                        <p>Loading...</p>
                    </div>
                ) : repliesPosts.length === 0 ? (
                    <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>
                        <p>No replies yet</p>
                    </div>
                ) : (
                    <>
                        {repliesPosts.map((post, index) => (
                            <PostCard
                                key={`${post.id}-${index}`}
                                post={post}
                                onLike={handleLike}
                                onRepost={handleRepost}
                                onComment={handleComment}
                                onDelete={handleDelete}
                                showParentContext
                            />
                        ))}
                        <div ref={loadMoreRef} style={{ padding: '24px', textAlign: 'center' }}>
                            {repliesLoadingMore && (
                                <span style={{ color: 'var(--foreground-tertiary)' }}>Loading more...</span>
                            )}
                        </div>
                    </>
                )
            )}

            {activeTab === 'likes' && (
                likesLoading ? (
                    <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>
                        <p>Loading...</p>
                    </div>
                ) : likedPosts.length === 0 ? (
                    <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>
                        <p>No liked posts yet</p>
                    </div>
                ) : (
                    likedPosts.map((post, index) => (
                        <PostCard
                            key={`${post.id}-${index}`}
                            post={post}
                            onLike={handleLike}
                            onRepost={handleRepost}
                            onComment={handleComment}
                            onDelete={handleDelete}
                        />
                    ))
                )
            )}

            {activeTab === 'followers' && (
                followersLoading ? (
                    <div style={{ padding: '24px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>
                        Loading followers...
                    </div>
                ) : followers.length === 0 ? (
                    <div style={{ padding: '24px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>
                        <p>No followers yet</p>
                    </div>
                ) : (
                    <div>
                        {followers.map(follower => (
                            <UserRow key={follower.id} user={follower} />
                        ))}
                    </div>
                )
            )}

            {activeTab === 'following' && (
                followingLoading ? (
                    <div style={{ padding: '24px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>
                        Loading following...
                    </div>
                ) : following.length === 0 ? (
                    <div style={{ padding: '24px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>
                        <p>Not following anyone yet</p>
                    </div>
                ) : (
                    <div>
                        {following.map(userItem => (
                            <UserRow key={userItem.id} user={userItem} />
                        ))}
                    </div>
                )
            )}
        </div>
    );
}
