'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { SearchIcon, TrendingIcon, UsersIcon } from '@/components/Icons';
import { PostCard } from '@/components/PostCard';
import { Post } from '@/lib/types';
import { useFormattedHandle } from '@/lib/utils/handle';
import { Bot, Network, Server, EyeOff } from 'lucide-react';
import { useAuth } from '@/lib/contexts/AuthContext';

interface User {
    id: string;
    handle: string;
    displayName: string;
    avatarUrl?: string;
    bio?: string;
    profileUrl?: string | null;
    isRemote?: boolean;
    isBot?: boolean;
}

function UserCard({ user }: { user: User }) {
    const fullHandle = useFormattedHandle(user.handle);
    return (
        <Link href={`/u/${user.handle}`} className="user-card">
            <div className="avatar">
                {user.avatarUrl ? (
                    <img src={user.avatarUrl} alt={user.displayName} />
                ) : (
                    user.displayName?.charAt(0).toUpperCase() || user.handle.charAt(0).toUpperCase()
                )}
            </div>
            <div className="user-card-info">
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span className="user-card-name">{user.displayName || user.handle}</span>
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
                <div className="user-card-handle">{fullHandle}</div>
                {user.bio && <div className="user-card-bio">{user.bio}</div>}
            </div>
        </Link>
    );
}

interface SwarmPost {
    id: string;
    content: string;
    createdAt: string;
    author: {
        handle: string;
        displayName: string;
        avatarUrl?: string;
    };
    nodeDomain: string;
    likeCount: number;
    repostCount: number;
    replyCount: number;
    media?: { url: string; mimeType?: string; altText?: string }[];
    linkPreviewUrl?: string;
    linkPreviewTitle?: string;
    linkPreviewDescription?: string;
    linkPreviewImage?: string;
}

export default function ExplorePage() {
    const { user } = useAuth();
    const [query, setQuery] = useState('');
    const [activeTab, setActiveTab] = useState<'node' | 'swarm' | 'users' | 'search'>('node');
    const [nodePosts, setNodePosts] = useState<Post[]>([]);
    const [swarmPosts, setSwarmPosts] = useState<SwarmPost[]>([]);
    const [swarmSources, setSwarmSources] = useState<{ domain: string; postCount: number }[]>([]);
    const [users, setUsers] = useState<User[]>([]);
    const [searchResults, setSearchResults] = useState<{ posts: Post[]; users: User[] }>({ posts: [], users: [] });
    const [loading, setLoading] = useState(true);
    const [searching, setSearching] = useState(false);
    const [nodeCursor, setNodeCursor] = useState<string | null>(null);
    const [swarmCursor, setSwarmCursor] = useState<string | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMoreNode, setHasMoreNode] = useState(true);
    const [hasMoreSwarm, setHasMoreSwarm] = useState(true);
    const [isNsfwNode, setIsNsfwNode] = useState(false);

    // Fetch node info to check if NSFW
    useEffect(() => {
        fetch('/api/node')
            .then(res => res.json())
            .then(data => {
                setIsNsfwNode(data.isNsfw || false);
            })
            .catch(() => { });
    }, []);

    useEffect(() => {
        // Load node posts (local only)
        const loadNodePosts = async () => {
            setLoading(true);
            try {
                const res = await fetch('/api/posts?type=local&limit=20');
                const data = await res.json();
                setNodePosts(data.posts || []);
                setNodeCursor(data.nextCursor || null);
                setHasMoreNode(!!data.nextCursor);
            } catch {
                setNodePosts([]);
            } finally {
                setLoading(false);
            }
        };

        if (activeTab === 'node' && nodePosts.length === 0) {
            loadNodePosts();
        }
    }, [activeTab, nodePosts.length]);

    useEffect(() => {
        // Load swarm posts when tab changes
        if (activeTab === 'swarm' && swarmPosts.length === 0) {
            const loadSwarm = async () => {
                setLoading(true);
                try {
                    const res = await fetch('/api/posts/swarm');
                    const data = await res.json();
                    setSwarmPosts(data.posts || []);
                    setSwarmSources(data.sources || []);

                    // Set cursor from the last post if available
                    if (data.posts && data.posts.length > 0) {
                        const lastPost = data.posts[data.posts.length - 1];
                        setSwarmCursor(lastPost.createdAt); // Use timestamp as cursor
                        setHasMoreSwarm(true);
                    } else {
                        setHasMoreSwarm(false);
                    }
                } catch {
                    setSwarmPosts([]);
                } finally {
                    setLoading(false);
                }
            };
            loadSwarm();
        }
    }, [activeTab, swarmPosts.length]);

    // Load more node posts
    const loadMoreNode = async () => {
        if (!nodeCursor || loadingMore || !hasMoreNode) return;
        setLoadingMore(true);
        try {
            const res = await fetch(`/api/posts?type=local&limit=20&cursor=${nodeCursor}`);
            const data = await res.json();
            if (data.posts && data.posts.length > 0) {
                setNodePosts(prev => [...prev, ...data.posts]);
                setNodeCursor(data.nextCursor || null);
                setHasMoreNode(!!data.nextCursor);
            } else {
                setHasMoreNode(false);
            }
        } catch {
            // Error loading more
        } finally {
            setLoadingMore(false);
        }
    };

    // Load more swarm posts
    const loadMoreSwarm = async () => {
        if (!swarmCursor || loadingMore || !hasMoreSwarm) return;
        setLoadingMore(true);
        try {
            // Use timestamp of last post as cursor
            const res = await fetch(`/api/posts/swarm?limit=20&cursor=${encodeURIComponent(swarmCursor)}`);
            const data = await res.json();
            if (data.posts && data.posts.length > 0) {
                setSwarmPosts(prev => [...prev, ...data.posts]);

                const lastPost = data.posts[data.posts.length - 1];
                setSwarmCursor(lastPost.createdAt);
                setHasMoreSwarm(true);
            } else {
                setHasMoreSwarm(false);
            }
        } catch {
            // Error loading more
        } finally {
            setLoadingMore(false);
        }
    };

    // Intersection Observer for Infinite Scroll
    useEffect(() => {
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting) {
                    if (activeTab === 'node') {
                        loadMoreNode();
                    } else if (activeTab === 'swarm') {
                        loadMoreSwarm();
                    }
                }
            },
            { threshold: 0.5 }
        );

        const sentinel = document.getElementById('scroll-sentinel');
        if (sentinel) {
            observer.observe(sentinel);
        }

        return () => observer.disconnect();
    }, [activeTab, nodeCursor, swarmCursor, loadingMore, hasMoreNode, hasMoreSwarm]);

    useEffect(() => {
        // Load users when tab changes to users
        if (activeTab === 'users' && users.length === 0) {
            const loadUsers = async () => {
                setLoading(true);
                try {
                    const res = await fetch('/api/users?limit=20');
                    const data = await res.json();
                    setUsers(data.users || []);
                } catch {
                    setUsers([]);
                } finally {
                    setLoading(false);
                }
            };
            loadUsers();
        }
    }, [activeTab, users.length]);

    const handleSearch = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!query.trim()) return;

        setSearching(true);
        setActiveTab('search');

        try {
            const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
            const data = await res.json();
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
        const method = currentLiked ? 'DELETE' : 'POST';
        await fetch(`/api/posts/${postId}/like`, { method });
    };

    const handleRepost = async (postId: string, currentReposted: boolean) => {
        const method = currentReposted ? 'DELETE' : 'POST';
        const res = await fetch(`/api/posts/${postId}/repost`, { method });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Failed to update repost');
        }
    };

    const handleDelete = (postId: string) => {
        setNodePosts(prev => prev.filter(p => p.id !== postId));
        setSwarmPosts(prev => prev.filter(p => p.id !== postId));
        setSearchResults(prev => ({
            ...prev,
            posts: prev.posts.filter(p => p.id !== postId)
        }));
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
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <h1 style={{ fontSize: '20px', fontWeight: 600 }}>Explore</h1>
                </div>
            </header>

            <div style={{ padding: '0 16px' }}>
                <form onSubmit={handleSearch} className="explore-search" style={{ marginTop: '16px' }}>
                    <SearchIcon />
                    <input
                        type="text"
                        placeholder="Search posts and users..."
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                </form>
            </div>

            <div className="explore-tabs">
                <button
                    className={`explore-tab ${activeTab === 'node' ? 'active' : ''}`}
                    onClick={() => setActiveTab('node')}
                >
                    <Server size={18} />
                    <span>Node</span>
                </button>
                <button
                    className={`explore-tab ${activeTab === 'swarm' ? 'active' : ''}`}
                    onClick={() => setActiveTab('swarm')}
                >
                    <Network size={18} />
                    <span>Swarm</span>
                </button>
                <button
                    className={`explore-tab ${activeTab === 'users' ? 'active' : ''}`}
                    onClick={() => setActiveTab('users')}
                >
                    <UsersIcon />
                    <span>Users</span>
                </button>
                {searchResults.posts.length > 0 || searchResults.users.length > 0 ? (
                    <button
                        className={`explore-tab ${activeTab === 'search' ? 'active' : ''}`}
                        onClick={() => setActiveTab('search')}
                    >
                        <SearchIcon />
                        <span>Results</span>
                    </button>
                ) : null}
            </div>

            <div className="explore-content">
                {activeTab === 'node' && (
                    !user && isNsfwNode ? (
                        <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                            <EyeOff size={48} style={{ marginBottom: '16px', opacity: 0.5 }} />
                            <p style={{ fontSize: '16px', fontWeight: 500, color: 'var(--foreground-secondary)', marginBottom: '8px' }}>
                                Adult Content
                            </p>
                            <p style={{ fontSize: '14px', maxWidth: '320px', margin: '0 auto' }}>
                                This node contains adult or sensitive content. You must be 18 or older and signed in to view posts.
                            </p>
                        </div>
                    ) : loading ? (
                        <div className="explore-loading">Loading posts...</div>
                    ) : nodePosts.length === 0 ? (
                        <>
                            <div className="feed-meta card">
                                <div className="feed-meta-title">Node feed</div>
                                <div className="feed-meta-body">
                                    A chronological feed of all posts from users on this node. See what the local community is sharing.
                                </div>
                            </div>
                            <div className="explore-empty">
                                <Server size={24} />
                                <p>No posts on this node yet</p>
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="feed-meta card">
                                <div className="feed-meta-title">Node feed</div>
                                <div className="feed-meta-body">
                                    A chronological feed of all posts from users on this node. See what the local community is sharing.
                                </div>
                            </div>
                            <div className="explore-posts">
                                {nodePosts.map((post) => (
                                    <PostCard key={post.id} post={post} onLike={handleLike} onRepost={handleRepost} onDelete={handleDelete} />
                                ))}
                                {/* Sentinel for Infinite Scroll */}
                                {hasMoreNode && (
                                    <div id="scroll-sentinel" style={{ height: '20px', margin: '20px 0', textAlign: 'center', opacity: 0.5 }}>
                                        {loadingMore ? 'Loading more...' : ''}
                                    </div>
                                )}
                            </div>
                        </>
                    )
                )}

                {activeTab === 'swarm' && (
                    loading ? (
                        <div className="explore-loading">Loading swarm posts...</div>
                    ) : swarmPosts.length === 0 ? (
                        <div className="explore-empty">
                            <Network size={24} />
                            <p>No swarm posts yet</p>
                            <p style={{ fontSize: '14px', opacity: 0.7, marginTop: '8px' }}>
                                Posts from other Synapsis nodes will appear here
                            </p>
                        </div>
                    ) : (
                        <>
                            <div className="feed-meta card">
                                <div className="feed-meta-title">Swarm feed</div>
                                <div className="feed-meta-body">
                                    Posts from across the Synapsis network. Currently showing posts from {swarmSources.filter(s => s.postCount > 0).length} node{swarmSources.filter(s => s.postCount > 0).length !== 1 ? 's' : ''}.
                                </div>
                            </div>
                            <div className="explore-posts">
                                {swarmPosts.map((post) => {
                                    // Transform swarm post to Post format for PostCard
                                    const transformedPost: Post = {
                                        id: `swarm:${post.nodeDomain}:${post.id}`,
                                        originalPostId: post.id,
                                        content: post.content,
                                        createdAt: post.createdAt,
                                        likesCount: post.likeCount,
                                        repostsCount: post.repostCount,
                                        repliesCount: post.replyCount,
                                        isSwarm: true,
                                        nodeDomain: post.nodeDomain,
                                        author: {
                                            id: `swarm:${post.nodeDomain}:${post.author.handle}`,
                                            handle: post.author.handle,
                                            displayName: post.author.displayName,
                                            avatarUrl: post.author.avatarUrl,
                                        },
                                        media: post.media?.map((m, idx) => ({
                                            id: `swarm:${post.nodeDomain}:${post.id}:media:${idx}`,
                                            url: m.url,
                                            altText: m.altText || null,
                                            mimeType: m.mimeType || null,
                                        })) || [],
                                        linkPreviewUrl: post.linkPreviewUrl || null,
                                        linkPreviewTitle: post.linkPreviewTitle || null,
                                        linkPreviewDescription: post.linkPreviewDescription || null,
                                        linkPreviewImage: post.linkPreviewImage || null,
                                    };
                                    return (
                                        <PostCard
                                            key={`${post.nodeDomain}:${post.id}`}
                                            post={transformedPost}
                                            onLike={handleLike}
                                            onRepost={handleRepost}
                                            onDelete={handleDelete}
                                        />
                                    );
                                })}
                                {/* Sentinel for Infinite Scroll */}
                                {hasMoreSwarm && (
                                    <div id="scroll-sentinel" style={{ height: '20px', margin: '20px 0', textAlign: 'center', opacity: 0.5 }}>
                                        {loadingMore ? 'Loading more...' : ''}
                                    </div>
                                )}
                            </div>
                        </>
                    )
                )}

                {activeTab === 'users' && (
                    loading ? (
                        <div className="explore-loading">Loading users...</div>
                    ) : users.length === 0 ? (
                        <div className="explore-empty">
                            <UsersIcon />
                            <p>No users found</p>
                        </div>
                    ) : (
                        <>
                            <div className="feed-meta card">
                                <div className="feed-meta-title">Users on this node</div>
                                <div className="feed-meta-body">
                                    People and bots with accounts on this Synapsis node. Follow them to see their posts in your timeline.
                                </div>
                            </div>
                            <div className="explore-users">
                                {users.map((user) => (
                                    <UserCard key={user.id} user={user} />
                                ))}
                            </div>
                        </>
                    )
                )}

                {activeTab === 'search' && (
                    searching ? (
                        <div className="explore-loading">Searching...</div>
                    ) : (
                        <div className="explore-search-results">
                            {searchResults.users.length > 0 && (
                                <div className="search-section">
                                    <h2>Users</h2>
                                    <div className="explore-users">
                                        {searchResults.users.map((user) => (
                                            <UserCard key={user.id} user={user} />
                                        ))}
                                    </div>
                                </div>
                            )}
                            {searchResults.posts.length > 0 && (
                                <div className="search-section">
                                    <h2>Posts</h2>
                                    <div className="explore-posts">
                                        {searchResults.posts.map((post) => (
                                            <PostCard key={post.id} post={post} onLike={handleLike} onRepost={handleRepost} onDelete={handleDelete} />
                                        ))}
                                    </div>
                                </div>
                            )}
                            {searchResults.users.length === 0 && searchResults.posts.length === 0 && (
                                <div className="explore-empty">
                                    <SearchIcon />
                                    <p>No results found for &ldquo;{query}&rdquo;</p>
                                </div>
                            )}
                        </div>
                    )
                )}
            </div>
        </div>
    );
}
