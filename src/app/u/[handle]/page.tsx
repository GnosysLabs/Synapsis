'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeftIcon, CalendarIcon } from '@/components/Icons';
import { PostCard } from '@/components/PostCard';
import { User, Post } from '@/lib/types';
import AutoTextarea from '@/components/AutoTextarea';
import { UserStorageImageUpload } from '@/components/UserStorageImageUpload';
import { Rocket, MoreHorizontal, Mail } from 'lucide-react';
import { useFormattedHandle } from '@/lib/utils/handle';
import { Bot } from 'lucide-react';
import { useAuth } from '@/lib/contexts/AuthContext';

interface BotOwner {
    id: string;
    handle: string;
    displayName?: string | null;
    avatarUrl?: string | null;
}

interface UserSummary {
    id: string;
    handle: string;
    displayName?: string | null;
    bio?: string | null;
    avatarUrl?: string | null;
    isBot?: boolean;
}

// Strip HTML tags from a string
const stripHtml = (html: string | null | undefined): string | null => {
    if (!html) return null;
    return html.replace(/<[^>]*>/g, '').trim() || null;
};

function UserRow({ user }: { user: UserSummary }) {
    const fullHandle = useFormattedHandle(user.handle);
    return (
        <Link href={`/u/${user.handle}`} className="user-row">
            <div className="avatar">
                {user.avatarUrl ? (
                    <img src={user.avatarUrl} alt={user.displayName || user.handle} />
                ) : (
                    (user.displayName || user.handle).charAt(0).toUpperCase()
                )}
            </div>
            <div className="user-row-content">
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontWeight: 600 }}>{user.displayName || user.handle}</span>
                    {user.isBot && (
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
                        >
                            <Bot size={12} />
                            AI Account
                        </span>
                    )}
                </div>
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
    const handle = (params.handle as string)?.replace(/^@/, '') || '';
    const { isIdentityUnlocked, signUserAction } = useAuth();

    const [user, setUser] = useState<User | null>(null);
    const userFullHandle = user ? useFormattedHandle(user.handle) : '';
    const [posts, setPosts] = useState<Post[]>([]);
    const [likedPosts, setLikedPosts] = useState<Post[]>([]);
    const [currentUser, setCurrentUser] = useState<{ id: string; handle: string } | null>(null);
    const [isFollowing, setIsFollowing] = useState(false);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<'posts' | 'replies' | 'likes' | 'followers' | 'following'>('posts');
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
    const [isBlocked, setIsBlocked] = useState(false);
    const [showMenu, setShowMenu] = useState(false);
    useEffect(() => {
        setIsEditing(false);
        setSaveError(null);
        setFollowers([]);
        setFollowing([]);
        setLikedPosts([]);
        setRepliesPosts([]);
        // Get current user
        fetch('/api/auth/me')
            .then(res => res.json())
            .then(data => setCurrentUser(data.user))
            .catch(() => { });

        // Get profile
        fetch(`/api/users/${handle}`)
            .then(res => res.json())
            .then(data => {
                setUser(data.user);
                setLoading(false);
            })
            .catch(() => setLoading(false));

        setPostsLoading(true);
        setPostsCursor(null);
        setRepliesCursor(null);
        fetch(`/api/users/${handle}/posts`)
            .then(res => res.json())
            .then(data => {
                setPosts(data.posts || []);
                setPostsCursor(data.nextCursor || null);
            })
            .catch(() => { })
            .finally(() => setPostsLoading(false));
    }, [handle]);

    // Infinite scroll ref
    const loadMoreRef = useRef<HTMLDivElement>(null);

    // Load more posts
    const loadMorePosts = useCallback(async () => {
        if (!postsCursor || postsLoadingMore) return;
        setPostsLoadingMore(true);
        try {
            const res = await fetch(`/api/users/${handle}/posts?cursor=${postsCursor}`);
            const data = await res.json();
            setPosts(prev => [...prev, ...(data.posts || [])]);
            setPostsCursor(data.nextCursor || null);
        } catch {
            // ignore
        } finally {
            setPostsLoadingMore(false);
        }
    }, [handle, postsCursor, postsLoadingMore]);

    // Load more replies
    const loadMoreReplies = useCallback(async () => {
        if (!repliesCursor || repliesLoadingMore || !user) return;
        setRepliesLoadingMore(true);
        try {
            const res = await fetch(`/api/posts?type=replies&userId=${user.id}&cursor=${repliesCursor}`);
            const data = await res.json();
            setRepliesPosts(prev => [...prev, ...(data.posts || [])]);
            setRepliesCursor(data.nextCursor || null);
        } catch {
            // ignore
        } finally {
            setRepliesLoadingMore(false);
        }
    }, [user, repliesCursor, repliesLoadingMore]);

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
        const method = currentLiked ? 'DELETE' : 'POST';
        await fetch(`/api/posts/${postId}/like`, { method });
    };

    const handleRepost = async (postId: string, currentReposted: boolean) => {
        const method = currentReposted ? 'DELETE' : 'POST';
        await fetch(`/api/posts/${postId}/repost`, { method });
    };

    const handleComment = (post: Post) => {
        // Navigation is handled by the PostCard overlay, 
        // but we can also use router.push if they explicitly click the comment button.
        router.push(`/u/${post.author.handle}/posts/${post.id}`);
    };

    const handleDelete = (postId: string) => {
        setPosts(prev => prev.filter(p => p.id !== postId));
        if (user && isOwnProfile) {
            setUser({
                ...user,
                postsCount: (user.postsCount || 0) - 1
            });
        }
    };

    useEffect(() => {
        if (user && currentUser?.handle === user.handle) {
            setProfileForm({
                displayName: user.displayName || '',
                bio: user.bio || '',
                avatarUrl: user.avatarUrl || '',
                headerUrl: user.headerUrl || '',
                website: user.website || '',
            });
        }
    }, [user, currentUser]);

    useEffect(() => {
        if (!currentUser || !user || currentUser.handle === user.handle) {
            setIsFollowing(false);
            setIsBlocked(false);
            return;
        }

        fetch(`/api/users/${handle}/follow`)
            .then(res => res.json())
            .then(data => setIsFollowing(!!data.following))
            .catch(() => setIsFollowing(false));

        fetch(`/api/users/${handle}/block`)
            .then(res => res.json())
            .then(data => setIsBlocked(!!data.blocked))
            .catch(() => setIsBlocked(false));
    }, [currentUser, user, handle]);

    useEffect(() => {
        if (activeTab === 'followers') {
            setFollowersLoading(true);
            fetch(`/api/users/${handle}/followers`)
                .then(res => res.json())
                .then(data => setFollowers(data.followers || []))
                .catch(() => setFollowers([]))
                .finally(() => setFollowersLoading(false));
        }

        if (activeTab === 'following') {
            setFollowingLoading(true);
            fetch(`/api/users/${handle}/following`)
                .then(res => res.json())
                .then(data => setFollowing(data.following || []))
                .catch(() => setFollowing([]))
                .finally(() => setFollowingLoading(false));
        }

        if (activeTab === 'likes') {
            setLikesLoading(true);
            fetch(`/api/users/${handle}/likes`)
                .then(res => res.json())
                .then(data => setLikedPosts(data.posts || []))
                .catch(() => setLikedPosts([]))
                .finally(() => setLikesLoading(false));
        }

        if (activeTab === 'replies' && user) {
            setRepliesLoading(true);
            setRepliesCursor(null);
            fetch(`/api/posts?type=replies&userId=${user.id}`)
                .then(res => res.json())
                .then(data => {
                    setRepliesPosts(data.posts || []);
                    setRepliesCursor(data.nextCursor || null);
                })
                .catch(() => setRepliesPosts([]))
                .finally(() => setRepliesLoading(false));
        }
    }, [activeTab, handle, user]);

    const handleFollow = async () => {
        if (!currentUser) return;

        if (!isIdentityUnlocked) {
            alert('Session expired. Please log in again.');
            return;
        }

        const method = isFollowing ? 'DELETE' : 'POST';
        const res = await fetch(`/api/users/${handle}/follow`, { method });

        if (res.ok && user) {
            setIsFollowing(!isFollowing);
            setUser({
                ...user,
                followersCount: isFollowing ? (user.followersCount || 0) - 1 : (user.followersCount || 0) + 1,
            });
        }
    };

    const handleBlock = async () => {
        if (!currentUser) return;

        if (!isIdentityUnlocked) {
            alert('Session expired. Please log in again.');
            return;
        }

        const method = isBlocked ? 'DELETE' : 'POST';
        const res = await fetch(`/api/users/${handle}/block`, { method });

        if (res.ok) {
            setIsBlocked(!isBlocked);
            if (!isBlocked) {
                // If blocking, also unfollow
                setIsFollowing(false);
            }
            setShowMenu(false);
        }
    };

    const handleSaveProfile = async () => {
        if (!isOwnProfile) return;

        if (!isIdentityUnlocked) {
            setSaveError('Session expired. Please log in again.');
            return;
        }

        setIsSaving(true);
        setSaveError(null);

        try {
            // Sign the profile update action
            const signedPayload = await signUserAction('update_profile', profileForm);

            const res = await fetch('/api/auth/me', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(signedPayload),
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || 'Failed to update profile');
            }

            setUser(data.user);
            setIsEditing(false);
        } catch (error) {
            console.error('Profile update failed', error);
            setSaveError(error instanceof Error ? error.message : 'Unable to update profile. Please try again.');
        } finally {
            setIsSaving(false);
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

    const isOwnProfile = currentUser?.handle === user.handle;

    return (
        <div style={{ maxWidth: '600px', margin: '0 auto', minHeight: '100vh' }}>
            {/* Header */}
            <header style={{
                padding: '16px',
                display: 'flex',
                alignItems: 'center',
                gap: '24px',
                borderBottom: '1px solid var(--border)',
                position: 'sticky',
                top: 0,
                background: 'var(--background)',
                zIndex: 10,
            }}>
                <button
                    onClick={() => router.back()}
                    style={{
                        color: 'var(--foreground)',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: 0,
                        display: 'flex',
                        alignItems: 'center',
                    }}
                >
                    <ArrowLeftIcon />
                </button>
                <div>
                    <h1 style={{ fontSize: '18px', fontWeight: 600 }}>{user.displayName || user.handle}</h1>
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
                {/* Banner */}
                <div
                    style={{
                        height: '150px',
                        background: (isEditing ? profileForm.headerUrl : user.headerUrl)
                            ? `url(${isEditing ? profileForm.headerUrl : user.headerUrl}) center/cover`
                            : 'linear-gradient(135deg, var(--accent-muted) 0%, var(--background-tertiary) 100%)',
                        position: 'relative',
                    }}
                >
                </div>

                {/* Avatar & Actions */}
                <div style={{ padding: '0 16px' }}>
                    <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                    }}>
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
                            {(isEditing ? profileForm.avatarUrl : user.avatarUrl) ? (
                                <img src={(isEditing ? profileForm.avatarUrl : user.avatarUrl) || ''} alt={user.displayName || user.handle} />
                            ) : (
                                (user.displayName || user.handle).charAt(0).toUpperCase()
                            )}
                        </div>

                        <div style={{ paddingTop: '12px', display: 'flex', gap: '8px', alignItems: 'center' }}>
                            {!isOwnProfile && currentUser && (
                                <>
                                    {!isBlocked && (
                                        <button
                                            className={`btn ${isFollowing ? '' : 'btn-primary'}`}
                                            onClick={handleFollow}
                                        >
                                            {isFollowing ? 'Following' : 'Follow'}
                                        </button>
                                    )}
                                    {/* Message Button (V2 Chat) - Respect privacy settings */}
                                    {user.did && !user.isBot && (user as any).canReceiveDms !== false && (
                                        <Link href={`/chat?compose=${user.handle}`} className="btn btn-ghost" style={{ padding: '8px' }}>
                                            <Mail size={20} />
                                        </Link>
                                    )}
                                    <div style={{ position: 'relative' }}>
                                        <button
                                            className="btn btn-ghost"
                                            onClick={() => setShowMenu(!showMenu)}
                                            style={{ padding: '8px' }}
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
                                                <div style={{
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
                        <h2 style={{ fontSize: '20px', fontWeight: 700 }}>{user.displayName || user.handle}</h2>
                        <p style={{ color: 'var(--foreground-tertiary)' }}>{userFullHandle}</p>

                        {user.bio && (
                            <p style={{ marginTop: '12px', lineHeight: 1.5 }}>{user.bio}</p>
                        )}

                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            marginTop: '12px',
                            color: 'var(--foreground-tertiary)',
                            fontSize: '14px',
                        }}>
                            <CalendarIcon />
                            <span>Joined {formatDate(user.createdAt || new Date().toISOString())}</span>
                        </div>

                        {user.website && (
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                marginTop: '4px',
                                color: 'var(--accent)',
                                fontSize: '14px',
                            }}>
                                <Link
                                    href={user.website.startsWith('http') ? user.website : `https://${user.website}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{ color: 'inherit', textDecoration: 'none' }}
                                >
                                    {user.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}
                                </Link>
                            </div>
                        )}

                        {/* Bot indicator and owner info */}
                        {user.isBot && (
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                marginTop: '12px',
                                padding: '8px 12px',
                                background: 'var(--accent-muted)',
                                borderRadius: 'var(--radius-md)',
                                fontSize: '14px',
                            }}>
                                <Bot size={16} style={{ color: 'var(--accent)' }} />
                                <span style={{ color: 'var(--foreground-secondary)' }}>
                                    Automated account
                                    {(user as any).botOwner && (
                                        <>
                                            {' · Managed by '}
                                            <Link
                                                href={`/u/${(user as any).botOwner.handle}`}
                                                style={{ color: 'var(--accent)', fontWeight: 500 }}
                                            >
                                                @{(user as any).botOwner.handle}
                                            </Link>
                                        </>
                                    )}
                                </span>
                            </div>
                        )}

                        <div style={{ display: 'flex', gap: '16px', marginTop: '12px' }}>
                            <button
                                onClick={() => setActiveTab('followers')}
                                style={{
                                    background: 'none',
                                    border: 'none',
                                    color: 'var(--foreground)',
                                    cursor: 'pointer',
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
                                    color: 'var(--foreground)',
                                    cursor: 'pointer',
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
                                <UserStorageImageUpload
                                    label="Avatar"
                                    value={profileForm.avatarUrl}
                                    onChange={(avatarUrl) => {
                                        setSaveError(null);
                                        setProfileForm({ ...profileForm, avatarUrl });
                                    }}
                                    previewWidth={48}
                                    previewHeight={48}
                                    previewBorderRadius="50%"
                                    helperText="Square image recommended (optional)"
                                    onError={(message) => setSaveError(message || null)}
                                />
                                <UserStorageImageUpload
                                    label="Header"
                                    value={profileForm.headerUrl}
                                    onChange={(headerUrl) => {
                                        setSaveError(null);
                                        setProfileForm({ ...profileForm, headerUrl });
                                    }}
                                    previewWidth={120}
                                    previewHeight={40}
                                    previewBorderRadius="4px"
                                    helperText="Wide image recommended, e.g. 1500x500 (optional)"
                                    onError={(message) => setSaveError(message || null)}
                                />
                                {saveError && (
                                    <div style={{ color: 'var(--error)', fontSize: '13px' }}>{saveError}</div>
                                )}
                                <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '8px' }}>
                                    <button className="btn btn-ghost" onClick={() => setIsEditing(false)} disabled={isSaving}>
                                        Cancel
                                    </button>
                                    <button className="btn btn-primary" onClick={handleSaveProfile} disabled={isSaving}>
                                        {isSaving ? 'Saving...' : 'Save'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Tabs */}
                <div style={{ display: 'flex', borderTop: '1px solid var(--border)' }}>
                    {(user?.isBot
                        ? ['posts', 'replies', 'followers', 'following'] as const
                        : ['posts', 'replies', 'likes', 'followers', 'following'] as const
                    ).map(tab => (
                        <button
                            key={tab}
                            onClick={() => setActiveTab(tab)}
                            style={{
                                flex: 1,
                                padding: '16px',
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
