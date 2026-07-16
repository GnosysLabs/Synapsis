'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/contexts/AuthContext';
import { PostCard } from '@/components/PostCard';
import { Compose } from '@/components/Compose';
import { Post } from '@/lib/types';
import { signedAPI } from '@/lib/api/signed-fetch';
import { DEFAULT_HOME_FEED, HOME_FEED_API_TYPES, HOME_FEED_LABELS, type HomeFeedType } from '@/lib/posts/home-feed';
import type { LinkPreviewData } from '@/lib/media/linkPreview';

export default function Home() {
  const router = useRouter();
  const { user, did, handle } = useAuth();
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<Post | null>(null);
  const [feedType, setFeedType] = useState<HomeFeedType>(DEFAULT_HOME_FEED);
  const [feedMeta, setFeedMeta] = useState<{
    algorithm: string;
    windowHours: number;
    seedLimit: number;
    weights: {
      engagement: number;
      recency: number;
      authorRepeat: number;
      nodeRepeat: number;
      formatRepeat: number;
      consecutiveAuthor: number;
      consecutiveNode: number;
    };
  } | null>(null);

  const loadMoreRef = useRef<HTMLDivElement>(null);
  const loadingCursorRef = useRef<string | null>(null);

  // Redirect unauthenticated users to explore page
  useEffect(() => {
    if (user === null) {
      router.push('/explore');
    }
  }, [user, router]);

  const feedTypeRef = useRef(feedType);

  useEffect(() => {
    feedTypeRef.current = feedType;
  }, [feedType]);

  const loadFeed = async (type: HomeFeedType, cursor?: string | null) => {
    if (cursor && loadingCursorRef.current === cursor) return;
    if (cursor) loadingCursorRef.current = cursor;

    if (cursor) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    try {
      const apiType = HOME_FEED_API_TYPES[type];
      const endpoint = `/api/posts?type=${apiType}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;

      const res = await fetch(endpoint);
      const data = await res.json();

      // Race condition check: ignore if user switched tabs
      if (type !== feedTypeRef.current) return;

      if (cursor) {
        setPosts(prev => {
          const seen = new Set(prev.map(post => post.id));
          const newPosts = (data.posts || []).filter((post: Post) => {
            if (seen.has(post.id)) return false;
            seen.add(post.id);
            return true;
          });
          return [...prev, ...newPosts];
        });
      } else {
        setPosts(data.posts || []);
      }
      setFeedMeta(data.meta || null);
      setNextCursor(data.nextCursor && data.nextCursor !== cursor ? data.nextCursor : null);
    } catch {
      if (type !== feedTypeRef.current) return;

      if (!cursor) {
        setPosts([]);
      }
      setFeedMeta(null);
      setNextCursor(null);
    } finally {
      if (type === feedTypeRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
      if (cursor && loadingCursorRef.current === cursor) {
        loadingCursorRef.current = null;
      }
    }
  };

  useEffect(() => {
    setPosts([]);
    setNextCursor(null);
    loadFeed(feedType);
  }, [feedType]);

  // Infinite scroll observer
  useEffect(() => {
    if (!loadMoreRef.current || !nextCursor || loadingMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && nextCursor && !loadingMore) {
          loadFeed(feedType, nextCursor);
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [nextCursor, loadingMore, feedType]);

  const handlePost = async (content: string, mediaIds: string[], linkPreview?: LinkPreviewData, replyToId?: string, isNsfw?: boolean) => {
    // Check if we're replying to a swarm post
    let swarmReplyTo: { postId: string; nodeDomain: string } | undefined;
    let localReplyToId: string | undefined = replyToId;

    if (replyingTo?.isSwarm && replyingTo.nodeDomain && replyingTo.originalPostId) {
      // This is a reply to a swarm post - send to the origin node
      swarmReplyTo = {
        postId: replyingTo.originalPostId,
        nodeDomain: replyingTo.nodeDomain,
      };
      localReplyToId = undefined; // Don't set local replyToId for swarm posts
    }

    if (!user || !did || !handle) {
      console.error('User identity missing');
      return;
    }

    const res = await signedAPI.createPost(
      content,
      mediaIds,
      linkPreview,
      localReplyToId,
      swarmReplyTo,
      isNsfw || false,
      did,
      handle
    );

    if (res.ok) {
      const data = await res.json();
      if (feedType === 'explore') {
        setPosts([]);
        setNextCursor(null);
        loadFeed('explore');
      } else {
        setPosts([{ ...data.post, author: user }, ...posts]);
      }
      setReplyingTo(null);
    }
  };

  const handleLike = async (postId: string, currentLiked: boolean) => {
    if (!did || !handle) return;
    const res = currentLiked
      ? await signedAPI.unlikePost(postId, did, handle)
      : await signedAPI.likePost(postId, did, handle);

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to update like');
    }
  };

  const handleRepost = async (postId: string, currentReposted: boolean) => {
    if (!did || !handle) return;
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

  // Show loading while checking auth
  if (user === null) {
    return (
      <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>
        Loading...
      </div>
    );
  }

  return (
    <>
      <header className="home-feed-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: '20px', fontWeight: 600 }}>Home</h1>
          <div className="feed-toggle" role="tablist" aria-label="Home feed">
            <button
              className={`feed-toggle-btn ${feedType === 'node' ? 'active' : ''}`}
              onClick={() => setFeedType('node')}
              role="tab"
              aria-selected={feedType === 'node'}
            >
              {HOME_FEED_LABELS.node}
            </button>
            <button
              className={`feed-toggle-btn ${feedType === 'following' ? 'active' : ''}`}
              onClick={() => setFeedType('following')}
              role="tab"
              aria-selected={feedType === 'following'}
            >
              {HOME_FEED_LABELS.following}
            </button>
            <button
              className={`feed-toggle-btn ${feedType === 'explore' ? 'active' : ''}`}
              onClick={() => setFeedType('explore')}
              role="tab"
              aria-selected={feedType === 'explore'}
            >
              {HOME_FEED_LABELS.explore}
            </button>
          </div>
        </div>
      </header>

      <Compose
        onPost={handlePost}
        replyingTo={replyingTo}
        onCancelReply={() => setReplyingTo(null)}
      />

      {feedType === 'node' && (
        <div className="feed-meta card">
          <div className="feed-meta-title">Node feed</div>
          <div className="feed-meta-body">
            All posts published by accounts hosted on this node, with the newest posts first.
          </div>
        </div>
      )}

      {feedType === 'following' && (
        <div className="feed-meta card">
          <div className="feed-meta-title">Following feed</div>
          <div className="feed-meta-body">
            Posts from accounts you follow across the Synapsis network, with the newest posts first.
          </div>
        </div>
      )}

      {feedType === 'explore' && feedMeta && (
        <div className="feed-meta card">
          <div className="feed-meta-title">Explore</div>
          <div className="feed-meta-body">
            Discover posts from nodes across the Synapsis network, balanced for freshness, active discussions, and variety.
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>
          Loading...
        </div>
      ) : posts.length === 0 ? (
        <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>
          {feedType === 'explore' ? (
            <>
              <p>No posts from the swarm yet</p>
              <p style={{ fontSize: '13px', marginTop: '8px' }}>
                Explore brings together posts from nodes across the Synapsis network.
                Check back as nodes are discovered, or switch to Node or Following.
              </p>
            </>
          ) : feedType === 'following' ? (
            <>
              <p>No posts from accounts you follow yet</p>
              <p style={{ fontSize: '13px', marginTop: '8px' }}>Follow people locally or across the swarm to build this feed.</p>
            </>
          ) : (
            <>
              <p>No posts on this node yet</p>
              <p style={{ fontSize: '13px', marginTop: '8px' }}>Be the first to post something!</p>
            </>
          )}
        </div>
      ) : (
        <>
          {posts.map(post => (
            <PostCard
              key={post.id}
              post={post}
              onLike={handleLike}
              onRepost={handleRepost}
              onDelete={handleDelete}
              onComment={(p) => {
                setReplyingTo(p);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            />
          ))}
          {/* Infinite scroll trigger */}
          <div ref={loadMoreRef} style={{ padding: '24px', textAlign: 'center' }}>
            {loadingMore && (
              <span style={{ color: 'var(--foreground-tertiary)' }}>Loading more...</span>
            )}
          </div>
        </>
      )}
    </>
  );
}
