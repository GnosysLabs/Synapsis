'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Network } from 'lucide-react';
import { SearchIcon, UsersIcon } from '@/components/Icons';
import { PostCard } from '@/components/PostCard';
import { AvatarImage } from '@/components/AvatarImage';
import { signedAPI } from '@/lib/api/signed-fetch';
import { useAuth } from '@/lib/contexts/AuthContext';
import { ANONYMOUS_APP_DESTINATION } from '@/lib/posts/home-feed';
import { EXPLORE_FEED_API_TYPE, EXPLORE_TABS, type ExploreTab } from '@/lib/posts/explore-feed';
import type { Post, User } from '@/lib/types';
import { useFormattedHandle } from '@/lib/utils/handle';

function UserCard({ user }: { user: User }) {
    const fullHandle = useFormattedHandle(user.handle);

    return (
        <Link href={`/u/${user.handle}`} className="user-card">
            <div className="avatar">
                <AvatarImage
                    avatarUrl={user.avatarUrl}
                    seed={user.handle}
                    nodeDomain={user.nodeDomain}
                    isNsfw={user.isNsfw}
                    nodeIsNsfw={user.nodeIsNsfw}
                    alt={user.displayName || user.handle}
                />
            </div>
            <div className="user-card-info">
                <span className="user-card-name">{user.displayName || user.handle}</span>
                <div className="user-card-handle">{fullHandle}</div>
                {user.bio && <div className="user-card-bio">{user.bio}</div>}
            </div>
        </Link>
    );
}

export default function ExplorePage() {
    const router = useRouter();
    const { user, loading: authLoading, did, handle } = useAuth();
    const [activeTab, setActiveTab] = useState<ExploreTab>('explore');
    const [posts, setPosts] = useState<Post[]>([]);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [postsLoading, setPostsLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [users, setUsers] = useState<User[]>([]);
    const [usersLoading, setUsersLoading] = useState(false);
    const [usersLoaded, setUsersLoaded] = useState(false);
    const [query, setQuery] = useState('');
    const [searching, setSearching] = useState(false);
    const [hasSearched, setHasSearched] = useState(false);
    const [searchResults, setSearchResults] = useState<{ posts: Post[]; users: User[] }>({ posts: [], users: [] });
    const loadMoreRef = useRef<HTMLDivElement>(null);
    const loadingCursorRef = useRef<string | null>(null);

    const loadExplore = useCallback(async (cursor: string | null = null) => {
        if (cursor && loadingCursorRef.current === cursor) return;
        if (cursor) {
            loadingCursorRef.current = cursor;
            setLoadingMore(true);
        } else {
            setPostsLoading(true);
        }

        try {
            const endpoint = `/api/posts?type=${EXPLORE_FEED_API_TYPE}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
            const response = await fetch(endpoint);
            if (!response.ok) throw new Error('Failed to load Explore');

            const data = await response.json();
            const incomingPosts = (data.posts || []) as Post[];

            if (cursor) {
                setPosts((currentPosts) => {
                    const seen = new Set(currentPosts.map((post) => post.id));
                    return [
                        ...currentPosts,
                        ...incomingPosts.filter((post) => {
                            if (seen.has(post.id)) return false;
                            seen.add(post.id);
                            return true;
                        }),
                    ];
                });
            } else {
                setPosts(incomingPosts);
            }

            setNextCursor(data.nextCursor && data.nextCursor !== cursor ? data.nextCursor : null);
        } catch {
            if (!cursor) setPosts([]);
            setNextCursor(null);
        } finally {
            if (cursor && loadingCursorRef.current === cursor) {
                loadingCursorRef.current = null;
            }
            setPostsLoading(false);
            setLoadingMore(false);
        }
    }, []);

    useEffect(() => {
        if (!authLoading && !user) {
            router.replace(ANONYMOUS_APP_DESTINATION);
        }
    }, [authLoading, router, user]);

    useEffect(() => {
        if (user) void loadExplore();
    }, [loadExplore, user]);

    useEffect(() => {
        if (!user || activeTab !== 'users' || usersLoaded || usersLoading) return;

        const loadUsers = async () => {
            setUsersLoading(true);
            try {
                const response = await fetch('/api/users?limit=20');
                if (!response.ok) throw new Error('Failed to load users');
                const data = await response.json();
                setUsers(data.users || []);
            } catch {
                setUsers([]);
            } finally {
                setUsersLoaded(true);
                setUsersLoading(false);
            }
        };

        void loadUsers();
    }, [activeTab, user, usersLoaded, usersLoading]);

    useEffect(() => {
        if (activeTab !== 'explore' || hasSearched || !loadMoreRef.current || !nextCursor || loadingMore) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting) {
                    void loadExplore(nextCursor);
                }
            },
            { threshold: 0.1 }
        );

        observer.observe(loadMoreRef.current);
        return () => observer.disconnect();
    }, [activeTab, hasSearched, loadExplore, loadingMore, nextCursor]);

    const selectTab = (tab: ExploreTab) => {
        setActiveTab(tab);
        setHasSearched(false);
    };

    const handleSearch = async (event: React.FormEvent) => {
        event.preventDefault();
        const trimmedQuery = query.trim();

        if (!trimmedQuery) {
            setHasSearched(false);
            return;
        }

        setHasSearched(true);
        setSearching(true);

        try {
            const response = await fetch(`/api/search?q=${encodeURIComponent(trimmedQuery)}`);
            if (!response.ok) throw new Error('Search failed');
            const data = await response.json();
            setSearchResults({
                posts: data.posts || [],
                users: data.users || [],
            });
        } catch {
            setSearchResults({ posts: [], users: [] });
        } finally {
            setSearching(false);
        }
    };

    const handleLike = async (postId: string, currentLiked: boolean) => {
        if (!did || !handle) throw new Error('Please log in again.');

        const response = currentLiked
            ? await signedAPI.unlikePost(postId, did, handle)
            : await signedAPI.likePost(postId, did, handle);

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || 'Failed to update like');
        }
    };

    const handleRepost = async (postId: string, currentReposted: boolean) => {
        if (!did || !handle) throw new Error('Please log in again.');

        const response = currentReposted
            ? await signedAPI.unrepostPost(postId, did, handle)
            : await signedAPI.repostPost(postId, did, handle);

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || 'Failed to update repost');
        }
    };

    const handleDelete = (postId: string) => {
        setPosts((currentPosts) => currentPosts.filter((post) => post.id !== postId));
        setSearchResults((currentResults) => ({
            ...currentResults,
            posts: currentResults.posts.filter((post) => post.id !== postId),
        }));
    };

    const renderSearchResults = () => {
        if (searching) return <div className="explore-loading">Searching...</div>;

        if (searchResults.users.length === 0 && searchResults.posts.length === 0) {
            return (
                <div className="explore-empty">
                    <SearchIcon />
                    <p>No results found for &ldquo;{query.trim()}&rdquo;</p>
                </div>
            );
        }

        return (
            <div className="explore-search-results">
                {searchResults.users.length > 0 && (
                    <div className="search-section">
                        <h2>Users</h2>
                        <div className="explore-users">
                            {searchResults.users.map((resultUser) => (
                                <UserCard key={resultUser.id} user={resultUser} />
                            ))}
                        </div>
                    </div>
                )}
                {searchResults.posts.length > 0 && (
                    <div className="search-section">
                        <h2>Posts</h2>
                        <div className="explore-posts">
                            {searchResults.posts.map((post) => (
                                <PostCard
                                    key={post.id}
                                    post={post}
                                    onLike={handleLike}
                                    onRepost={handleRepost}
                                    onDelete={handleDelete}
                                />
                            ))}
                        </div>
                    </div>
                )}
            </div>
        );
    };

    const renderExplore = () => (
        <>
            <div className="feed-meta card">
                <div className="feed-meta-title">Explore</div>
                <div className="feed-meta-body">
                    Discover posts from nodes across the Synapsis network, balanced for freshness, active discussions, and variety.
                </div>
            </div>
            {postsLoading ? (
                <div className="explore-loading">Loading Explore...</div>
            ) : posts.length === 0 ? (
                <div className="explore-empty">
                    <Network size={24} />
                    <p>No posts to explore yet</p>
                    <p style={{ fontSize: '14px', opacity: 0.7 }}>
                        Posts will appear here as nodes and communities join the network.
                    </p>
                    {nextCursor && (
                        <div ref={loadMoreRef} style={{ padding: '12px', textAlign: 'center' }}>
                            {loadingMore ? 'Searching older posts...' : ''}
                        </div>
                    )}
                </div>
            ) : (
                <div className="explore-posts">
                    {posts.map((post) => (
                        <PostCard
                            key={post.id}
                            post={post}
                            onLike={handleLike}
                            onRepost={handleRepost}
                            onDelete={handleDelete}
                        />
                    ))}
                    {nextCursor && (
                        <div ref={loadMoreRef} style={{ minHeight: '40px', padding: '12px', textAlign: 'center', opacity: 0.6 }}>
                            {loadingMore ? 'Loading more...' : ''}
                        </div>
                    )}
                </div>
            )}
        </>
    );

    const renderUsers = () => (
        <>
            <div className="feed-meta card">
                <div className="feed-meta-title">Users on this node</div>
                <div className="feed-meta-body">
                    People with accounts on this Synapsis node. Follow them to see their posts in your Following feed.
                </div>
            </div>
            {!usersLoaded || usersLoading ? (
                <div className="explore-loading">Loading users...</div>
            ) : users.length === 0 ? (
                <div className="explore-empty">
                    <UsersIcon />
                    <p>No users found</p>
                </div>
            ) : (
                <div className="explore-users">
                    {users.map((listedUser) => (
                        <UserCard key={listedUser.id} user={listedUser} />
                    ))}
                </div>
            )}
        </>
    );

    if (authLoading || !user) {
        return <div className="explore-loading">Loading node feed...</div>;
    }

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
                <h1 style={{ fontSize: '20px', fontWeight: 600 }}>Explore</h1>
            </header>

            <div style={{ padding: '0 16px' }}>
                <form onSubmit={handleSearch} className="explore-search" style={{ marginTop: '16px' }}>
                    <SearchIcon />
                    <input
                        type="text"
                        placeholder="Search posts and users..."
                        value={query}
                        onChange={(event) => {
                            setQuery(event.target.value);
                            if (!event.target.value.trim()) setHasSearched(false);
                        }}
                    />
                </form>
            </div>

            <div className="explore-tabs" role="tablist" aria-label="Explore views">
                {EXPLORE_TABS.map((tab) => (
                    <button
                        key={tab.id}
                        className={`explore-tab ${activeTab === tab.id ? 'active' : ''}`}
                        onClick={() => selectTab(tab.id)}
                        role="tab"
                        aria-selected={activeTab === tab.id}
                    >
                        {tab.id === 'explore' ? <Network size={18} /> : <UsersIcon />}
                        <span>{tab.label}</span>
                    </button>
                ))}
            </div>

            <div className="explore-content">
                {hasSearched
                    ? renderSearchResults()
                    : activeTab === 'explore'
                        ? renderExplore()
                        : renderUsers()}
            </div>
        </div>
    );
}
