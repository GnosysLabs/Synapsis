'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { SearchIcon } from '@/components/Icons';
import { getProfilePath, useFormattedHandle } from '@/lib/utils/handle';
import { PostCard } from '@/components/PostCard';
import { Post } from '@/lib/types';
import { useAuth } from '@/lib/contexts/AuthContext';
import { signedAPI } from '@/lib/api/signed-fetch';
import { AvatarImage } from '@/components/AvatarImage';
import { getLiveSearchQuery, LIVE_SEARCH_DEBOUNCE_MS } from '@/lib/search/live-search';

interface User {
    id: string;
    handle: string;
    displayName: string;
    avatarUrl?: string;
    bio?: string;
    profileUrl?: string | null;
    isRemote?: boolean;
    isNsfw?: boolean;
    nodeIsNsfw?: boolean;
    nodeDomain?: string | null;
}

function UserCard({ user }: { user: User }) {
    const fullHandle = useFormattedHandle(user.handle);
    return (
        <Link
            href={getProfilePath(user.handle)}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '16px',
                borderBottom: '1px solid var(--border)',
                transition: 'background 0.15s ease',
            }}
            className="hover-bg"
        >
            <div className="avatar">
                <AvatarImage avatarUrl={user.avatarUrl} seed={user.handle} nodeDomain={user.nodeDomain} isNsfw={user.isNsfw} nodeIsNsfw={user.nodeIsNsfw} alt={user.displayName || user.handle} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 600 }}>{user.displayName || user.handle}</span>
                <div style={{ color: 'var(--foreground-tertiary)', fontSize: '14px' }}>{fullHandle}</div>
                {user.bio && (
                    <div style={{
                        color: 'var(--foreground-secondary)',
                        fontSize: '14px',
                        marginTop: '4px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}>
                        {user.bio}
                    </div>
                )}
            </div>
        </Link>
    );
}



export default function SearchPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const initialQuery = searchParams.get('q') || '';
    const { did, handle } = useAuth();

    const [query, setQuery] = useState(initialQuery);
    const [users, setUsers] = useState<User[]>([]);
    const [posts, setPosts] = useState<Post[]>([]);
    const [loading, setLoading] = useState(false);
    const [searchedQuery, setSearchedQuery] = useState('');
    const [searchError, setSearchError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'all' | 'users' | 'posts'>('all');
    const liveSearchQuery = getLiveSearchQuery(query);

    const search = useCallback(async (q: string, type: string, signal: AbortSignal) => {
        if (!q.trim()) {
            setUsers([]);
            setPosts([]);
            setSearchError(null);
            return;
        }

        setLoading(true);
        setSearchError(null);
        try {
            const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&type=${type}`, {
                cache: 'no-store',
                signal,
            });
            if (!res.ok) throw new Error('Search failed');
            const data = await res.json();
            if (signal.aborted) return;
            setSearchedQuery(q);
            setUsers(data.users || []);
            setPosts(data.posts || []);
        } catch (error) {
            if (!signal.aborted) {
                console.error('Search failed', error);
                setSearchError('Search is unavailable right now. Please try again.');
            }
        } finally {
            if (!signal.aborted) setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!liveSearchQuery) {
            setUsers([]);
            setPosts([]);
            setSearchedQuery('');
            setSearchError(null);
            setLoading(false);
            return;
        }

        const controller = new AbortController();
        setLoading(true);
        setSearchedQuery(liveSearchQuery);
        setSearchError(null);
        setUsers([]);
        setPosts([]);
        const timeout = window.setTimeout(() => {
            void search(liveSearchQuery, activeTab, controller.signal);
        }, LIVE_SEARCH_DEBOUNCE_MS);

        return () => {
            window.clearTimeout(timeout);
            controller.abort();
        };
    }, [activeTab, liveSearchQuery, search]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (liveSearchQuery) {
            router.replace(`/search?q=${encodeURIComponent(liveSearchQuery)}`, { scroll: false });
        }
    };

    const handleTabChange = (tab: 'all' | 'users' | 'posts') => {
        setActiveTab(tab);
    };

    const handleLike = async (postId: string, currentLiked: boolean) => {
        if (!did || !handle) {
            throw new Error('Please log in again.');
        }

        const res = currentLiked
            ? await signedAPI.unlikePost(postId, did, handle)
            : await signedAPI.likePost(postId, did, handle);

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Failed to update like');
        }
    };

    const handleRepost = async (postId: string, currentReposted: boolean) => {
        if (!did || !handle) {
            throw new Error('Please log in again.');
        }

        const res = currentReposted
            ? await signedAPI.unrepostPost(postId, did, handle)
            : await signedAPI.repostPost(postId, did, handle);

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Failed to update repost');
        }
    };

    const handleDelete = (postId: string) => {
        setPosts(prev => prev.filter(p => p.id !== postId));
    };

    return (
        <div className="explore-page">
            <header style={{
                padding: '16px',
                borderBottom: '1px solid var(--border)',
                position: 'sticky',
                top: 0,
                background: 'rgba(10, 10, 10, 0.95)',
                zIndex: 10,
                backdropFilter: 'blur(12px)',
            }}>
                <h1 style={{ fontSize: '20px', fontWeight: 600 }}>Search</h1>
            </header>

            <div style={{ padding: '0 16px' }}>
                <form onSubmit={handleSubmit} className="explore-search" style={{ marginTop: '16px' }}>
                    <SearchIcon />
                    <input
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search users and posts..."
                        aria-label="Search users and posts"
                    />
                </form>
            </div>

            <div className="explore-tabs" role="tablist" aria-label="Search result types">
                {(['all', 'users', 'posts'] as const).map(tab => (
                    <button
                        key={tab}
                        type="button"
                        onClick={() => handleTabChange(tab)}
                        className={`explore-tab ${activeTab === tab ? 'active' : ''}`}
                        role="tab"
                        aria-selected={activeTab === tab}
                    >
                        {tab === 'all' ? 'All' : tab === 'users' ? 'Users' : 'Posts'}
                    </button>
                ))}
            </div>

            {loading ? (
                <div className="explore-loading">Searching...</div>
            ) : !liveSearchQuery ? (
                <div className="explore-empty">
                    <SearchIcon />
                    <p>Search for users and posts</p>
                </div>
            ) : searchError ? (
                <div className="explore-empty" role="alert">
                    <SearchIcon />
                    <p>{searchError}</p>
                </div>
            ) : users.length === 0 && posts.length === 0 ? (
                <div className="explore-empty">
                    <SearchIcon />
                    <p>No results for &ldquo;{searchedQuery}&rdquo;</p>
                </div>
            ) : (
                <>
                    {(activeTab === 'all' || activeTab === 'users') && users.length > 0 && (
                        <div>
                            {activeTab === 'all' && (
                                <div style={{
                                    padding: '12px 16px',
                                    fontWeight: 600,
                                    borderBottom: '1px solid var(--border)',
                                    background: 'var(--background-secondary)',
                                }}>
                                    Users
                                </div>
                            )}
                            {users.map(user => <UserCard key={user.id} user={user} />)}
                        </div>
                    )}

                    {(activeTab === 'all' || activeTab === 'posts') && posts.length > 0 && (
                        <div>
                            {activeTab === 'all' && (
                                <div style={{
                                    padding: '12px 16px',
                                    fontWeight: 600,
                                    borderBottom: '1px solid var(--border)',
                                    background: 'var(--background-secondary)',
                                }}>
                                    Posts
                                </div>
                            )}
                            {posts.map(post => (
                                <PostCard
                                    key={post.id}
                                    post={post}
                                    onLike={handleLike}
                                    onRepost={handleRepost}
                                    onDelete={handleDelete}
                                />
                            ))}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
