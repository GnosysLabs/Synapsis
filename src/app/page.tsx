'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/contexts/AuthContext';
import { PostCard } from '@/components/PostCard';
import { Compose } from '@/components/Compose';
import { Post } from '@/lib/types';
import { EyeOff } from 'lucide-react';
import { signedAPI } from '@/lib/api/signed-fetch';

interface FeedMeta {
  score: number;
  reasons: string[];
  engagement: {
    likes: number;
    reposts: number;
    replies: number;
  };
}

export default function Home() {
  const router = useRouter();
  const { user, did, handle } = useAuth();
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<Post | null>(null);
  const [feedType, setFeedType] = useState<'following' | 'curated'>('following');
  const [feedMeta, setFeedMeta] = useState<{
    algorithm: string;
    windowHours: number;
    seedLimit: number;
    weights: {
      engagement: number;
      recency: number;
      followBoost: number;
      selfBoost: number;
    };
  } | null>(null);

  const loadMoreRef = useRef<HTMLDivElement>(null);

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

  const loadFeed = async (type: 'following' | 'curated', cursor?: string | null) => {
    if (cursor) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    try {
      const endpoint = type === 'curated'
        ? `/api/posts?type=curated${cursor ? `&cursor=${cursor}` : ''}`
        : `/api/posts?type=home${cursor ? `&cursor=${cursor}` : ''}`;

      const res = await fetch(endpoint);
      const data = await res.json();

      // Race condition check: ignore if user switched tabs
      if (type !== feedTypeRef.current) return;

      if (cursor) {
        setPosts(prev => [...prev, ...(data.posts || [])]);
      } else {
        setPosts(data.posts || []);
      }
      setFeedMeta(data.meta || null);
      setNextCursor(data.nextCursor || null);
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

  const handlePost = async (content: string, mediaIds: string[], linkPreview?: any, replyToId?: string, isNsfw?: boolean) => {
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
      if (feedType === 'curated') {
        setPosts([]);
        setNextCursor(null);
        loadFeed('curated');
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
      <header style={{
        padding: '16px',
        borderBottom: '1px solid var(--border)',
        position: 'sticky',
        top: 0,
        background: 'rgba(10, 10, 10, 0.95)',
        zIndex: 10,
        backdropFilter: 'blur(12px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: '20px', fontWeight: 600 }}>Home</h1>
          <div className="feed-toggle">
            <button
              className={`feed-toggle-btn ${feedType === 'following' ? 'active' : ''}`}
              onClick={() => setFeedType('following')}
            >
              Following
            </button>
            <button
              className={`feed-toggle-btn ${feedType === 'curated' ? 'active' : ''}`}
              onClick={() => setFeedType('curated')}
            >
              Curated
            </button>
          </div>
        </div>
      </header>

      <Compose
        onPost={handlePost}
        replyingTo={replyingTo}
        onCancelReply={() => setReplyingTo(null)}
      />

      {feedType === 'following' && (
        <div className="feed-meta card">
          <div className="feed-meta-title">Following feed</div>
          <div className="feed-meta-body">
            This feed shows posts from accounts you follow in chronological order, with the most recent posts appearing first.
          </div>
        </div>
      )}

      {feedType === 'curated' && feedMeta && (
        <div className="feed-meta card">
          <div className="feed-meta-title">Curated feed</div>
          <div className="feed-meta-body">
            This feed highlights fresh posts and active discussions, with a boost for people you follow. It is designed to surface what matters without hiding your own activity.
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>
          Loading...
        </div>
      ) : posts.length === 0 ? (
        <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>
          {feedType === 'curated' ? (
            <>
              <p>No posts from the swarm yet</p>
              <p style={{ fontSize: '13px', marginTop: '8px' }}>
                The curated feed shows posts from other nodes in the Synapsis network.
                Check back later as nodes are discovered, or switch to Following to see posts from people you follow.
              </p>
            </>
          ) : (
            <>
              <p>No posts yet</p>
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
