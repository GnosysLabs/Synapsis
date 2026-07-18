'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, Loader2, RotateCcw } from 'lucide-react';

import { PostCard } from '@/components/PostCard';
import { signedAPI } from '@/lib/api/signed-fetch';
import { useAuth } from '@/lib/contexts/AuthContext';
import type { ChatPostLink } from '@/lib/chat/post-links';
import type { Post } from '@/lib/types';

interface ChatPostCardProps {
  link: ChatPostLink;
}

export function ChatPostCard({ link }: ChatPostCardProps) {
  const { did, handle } = useAuth();
  const [post, setPost] = useState<Post | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setPost(null);
    setError(null);

    const loadPost = async () => {
      try {
        const response = await fetch(`/api/posts/${encodeURIComponent(link.postId)}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.post) {
          throw new Error(typeof data.error === 'string' ? data.error : 'This post is unavailable.');
        }
        if (!controller.signal.aborted) setPost(data.post as Post);
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setError(loadError instanceof Error ? loadError.message : 'This post is unavailable.');
      }
    };
    void loadPost();
    return () => controller.abort();
  }, [link.postId, retryVersion]);

  const handleLike = async (postId: string, currentLiked: boolean) => {
    if (!did || !handle) throw new Error('Your secure session is not available.');
    const response = currentLiked
      ? await signedAPI.unlikePost(postId, did, handle)
      : await signedAPI.likePost(postId, did, handle);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'The like could not be updated.');
    }
  };

  const handleRepost = async (postId: string, currentReposted: boolean) => {
    if (!did || !handle) throw new Error('Your secure session is not available.');
    const response = currentReposted
      ? await signedAPI.unrepostPost(postId, did, handle)
      : await signedAPI.repostPost(postId, did, handle);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'The repost could not be updated.');
    }
  };

  if (error) {
    return (
      <div className="chat-post-card-fallback" role="status">
        <div>
          <div className="chat-post-card-fallback-title">Post unavailable</div>
          <div className="chat-post-card-fallback-message">{error}</div>
        </div>
        <div className="chat-post-card-fallback-actions">
          <button type="button" onClick={() => setRetryVersion((version) => version + 1)}>
            <RotateCcw size={14} aria-hidden="true" />
            Retry
          </button>
          <a href={link.url} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={14} aria-hidden="true" />
            Open post
          </a>
        </div>
      </div>
    );
  }

  if (!post) {
    return (
      <div className="chat-post-card-loading" aria-busy="true" aria-label="Loading shared post">
        <Loader2 size={18} className="animate-spin" aria-hidden="true" />
        <div>
          <span />
          <span />
        </div>
      </div>
    );
  }

  return (
    <div className="chat-post-card">
      <PostCard
        post={post}
        isEmbedded
        showThread={false}
        onLike={handleLike}
        onRepost={handleRepost}
        onDelete={() => {
          setPost(null);
          setError('This post was deleted.');
        }}
        onHide={() => {
          setPost(null);
          setError('This post is hidden.');
        }}
      />
    </div>
  );
}
