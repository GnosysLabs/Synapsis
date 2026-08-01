'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { TriangleAlert } from 'lucide-react';
import { useAuth } from '@/lib/contexts/AuthContext';
import { useRuntimeConfig } from '@/lib/contexts/ConfigContext';
import { PostCard } from '@/components/PostCard';
import { Compose } from '@/components/Compose';
import { Post } from '@/lib/types';
import { signedAPI } from '@/lib/api/signed-fetch';
import {
  DEFAULT_HOME_FEED,
  ANONYMOUS_HOME_FEED,
  HOME_FEED_API_TYPES,
  HOME_FEED_LABELS,
  type HomeFeedType,
} from '@/lib/posts/home-feed';
import { canAccessNodeFeed } from '@/lib/nsfw/feed-access';
import type { LinkPreviewData } from '@/lib/media/linkPreview';

function AdultNodeWarning() {
  return (
    <section className="adult-node-warning card" role="alert" aria-labelledby="adult-node-warning-title">
      <div className="adult-node-warning-icon" aria-hidden="true">
        <TriangleAlert size={30} />
      </div>
      <div>
        <h2 id="adult-node-warning-title">Adult content warning</h2>
        <p>This node contains adult or sensitive content intended only for adults.</p>
        <p>The node feed is available only after you sign in to an account hosted on this node.</p>
      </div>
      <Link href="/login" className="btn btn-primary">
        Sign in or create an account
      </Link>
    </section>
  );
}

function NodeConfigurationWarning() {
  return (
    <section className="adult-node-warning card" role="status" aria-labelledby="node-configuration-warning-title">
      <div className="adult-node-warning-icon" aria-hidden="true">
        <TriangleAlert size={30} />
      </div>
      <div>
        <h2 id="node-configuration-warning-title">Node configuration unavailable</h2>
        <p>This node could not load its settings. Content is temporarily hidden for safety.</p>
      </div>
      <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
        Try again
      </button>
    </section>
  );
}

export default function Home() {
  const { user, did, handle, loading: authLoading } = useAuth();
  const { config } = useRuntimeConfig();
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<Post | null>(null);
  const [feedType, setFeedType] = useState<HomeFeedType>(DEFAULT_HOME_FEED);
  const activeFeedType = user ? feedType : ANONYMOUS_HOME_FEED;
  const nodeConfigurationUnavailable = config?.classificationKnown !== true;
  const nodeFeedBlocked = nodeConfigurationUnavailable || !canAccessNodeFeed({
    isAuthenticated: Boolean(user),
    localNodeIsNsfw: config?.isNsfw === true,
  });

  const loadMoreRef = useRef<HTMLDivElement>(null);
  const loadingCursorRef = useRef<string | null>(null);

  const feedTypeRef = useRef(activeFeedType);

  useEffect(() => {
    feedTypeRef.current = activeFeedType;
  }, [activeFeedType]);

  const loadFeed = async (type: HomeFeedType, cursor?: string | null, options: { silent?: boolean } = {}): Promise<void> => {
    const { silent = false } = options;
    if (cursor && loadingCursorRef.current === cursor) return;
    if (cursor) loadingCursorRef.current = cursor;

    if (cursor) {
      setLoadingMore(true);
    } else if (!silent) {
      setLoading(true);
    }
    try {
      const apiType = HOME_FEED_API_TYPES[type];
      const endpoint = `/api/posts?type=${apiType}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;

      const res = await fetch(endpoint, { cache: 'no-store' });
      const data = await res.json();

      if (res.status === 410 && cursor && type === 'forYou') {
        loadingCursorRef.current = null;
        await loadFeed(type);
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Failed to load feed');

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
      setNextCursor(data.nextCursor && data.nextCursor !== cursor ? data.nextCursor : null);
    } catch {
      if (type !== feedTypeRef.current) return;

      if (!cursor) {
        setPosts([]);
      }
      setNextCursor(null);
    } finally {
      if (type === feedTypeRef.current) {
        if (!silent) setLoading(false);
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
    if (nodeFeedBlocked) {
      setLoading(false);
      return;
    }
    loadFeed(activeFeedType);
  }, [activeFeedType, nodeFeedBlocked]);

  // Infinite scroll observer
  useEffect(() => {
    if (!loadMoreRef.current || !nextCursor || loadingMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && nextCursor && !loadingMore) {
          loadFeed(activeFeedType, nextCursor);
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [nextCursor, loadingMore, activeFeedType]);

  const handlePost = async (content: string, mediaIds: string[], linkPreview?: LinkPreviewData | null, replyToId?: string, isNsfw?: boolean, mediaManifest: import('@/lib/types').SignedMediaDescriptor[] = [], collectionIds: string[] = []) => {
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
      mediaManifest,
      did,
      handle,
      collectionIds,
    );

    if (res.ok) {
      const data = await res.json();
      setPosts([{ ...data.post, author: user }, ...posts]);
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

    await loadFeed(activeFeedType, null, { silent: true });
  };

  const handleDelete = (postId: string) => {
    setPosts(prev => prev.filter(p => p.id !== postId));
  };

  const getPostOrigin = useCallback((post: Post) => (
    post.nodeDomain || post.author.nodeDomain || config?.domain || 'localhost:43821'
  ), [config?.domain]);

  const handleImpression = useCallback((post: Post) => {
    void fetch('/api/feed/impressions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        postKey: post.id,
        authorHandle: post.author.handle,
        nodeDomain: getPostOrigin(post),
      }),
      keepalive: true,
    }).catch(() => {});
  }, [getPostOrigin]);

  const handleNotInterested = useCallback(async (post: Post) => {
    const res = await fetch('/api/feed/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        postKey: post.id,
        authorHandle: post.author.handle,
        nodeDomain: getPostOrigin(post),
        kind: 'not_interested',
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Could not save feedback');
    }
  }, [getPostOrigin]);

  // Show loading while checking auth
  if (authLoading || !config) {
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
          <h1 style={{ fontSize: '20px', fontWeight: 600 }}>{user ? 'Home' : 'Node'}</h1>
          {user && (
            <div className="feed-toggle" role="tablist" aria-label="Home feed">
              <button
                className={`feed-toggle-btn ${activeFeedType === 'node' ? 'active' : ''}`}
                onClick={() => setFeedType('node')}
                role="tab"
                aria-selected={activeFeedType === 'node'}
              >
                {HOME_FEED_LABELS.node}
              </button>
              <button
                className={`feed-toggle-btn ${activeFeedType === 'forYou' ? 'active' : ''}`}
                onClick={() => setFeedType('forYou')}
                role="tab"
                aria-selected={activeFeedType === 'forYou'}
              >
                {HOME_FEED_LABELS.forYou}
              </button>
              <button
                className={`feed-toggle-btn ${activeFeedType === 'following' ? 'active' : ''}`}
                onClick={() => setFeedType('following')}
                role="tab"
                aria-selected={activeFeedType === 'following'}
              >
                {HOME_FEED_LABELS.following}
              </button>
            </div>
          )}
        </div>
      </header>

      {nodeConfigurationUnavailable ? (
        <NodeConfigurationWarning />
      ) : nodeFeedBlocked ? (
        <AdultNodeWarning />
      ) : (
        <>
          {user && (
            <Compose
              onPost={handlePost}
              replyingTo={replyingTo}
              onCancelReply={() => setReplyingTo(null)}
            />
          )}

          {activeFeedType === 'node' && (
            <div className="feed-meta card">
              <div className="feed-meta-title">Node feed</div>
              <div className="feed-meta-body">
                All posts published by accounts hosted on this node, with the newest posts first.
              </div>
            </div>
          )}

          {activeFeedType === 'forYou' && (
            <div className="feed-meta card">
              <div className="feed-meta-title">For You</div>
              <div className="feed-meta-body">
                Personalized from across Synapsis using who you follow, what you engage with, freshness, and a mix of voices and communities.
              </div>
            </div>
          )}

          {activeFeedType === 'following' && (
            <div className="feed-meta card">
              <div className="feed-meta-title">Following feed</div>
              <div className="feed-meta-body">
                Posts from accounts you follow across the Synapsis network, with the newest posts first.
              </div>
            </div>
          )}

          {loading ? (
            <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>
              Loading...
            </div>
          ) : posts.length === 0 ? (
            <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>
              {activeFeedType === 'forYou' ? (
                <>
                  <p>Nothing to recommend yet</p>
                  <p style={{ fontSize: '13px', marginTop: '8px' }}>As this node discovers posts, your feed will fill in automatically.</p>
                </>
              ) : activeFeedType === 'following' ? (
                <>
                  <p>No posts from accounts you follow yet</p>
                  <p style={{ fontSize: '13px', marginTop: '8px' }}>Follow people locally or across the swarm to build this feed.</p>
                </>
              ) : (
                <>
                  <p>No posts on this node yet</p>
                  <p style={{ fontSize: '13px', marginTop: '8px' }}>
                    {user ? 'Be the first to post something!' : 'Sign in to publish the first post.'}
                  </p>
                </>
              )}
              {nextCursor && (
                <div ref={loadMoreRef} style={{ padding: '24px', textAlign: 'center' }}>
                  <span style={{ fontSize: '13px' }}>Searching older posts...</span>
                </div>
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
                  onHide={handleDelete}
                  onImpression={activeFeedType === 'forYou' ? handleImpression : undefined}
                  onNotInterested={activeFeedType === 'forYou' ? handleNotInterested : undefined}
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
      )}
    </>
  );
}
