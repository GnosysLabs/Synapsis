'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeftIcon } from '@/components/Icons';
import { PostCard } from '@/components/PostCard';
import { Compose } from '@/components/Compose';
import { useAuth } from '@/lib/contexts/AuthContext';
import { Post } from '@/lib/types';
import { signedAPI } from '@/lib/api/signed-fetch';

export default function PostDetailPage() {
    const params = useParams();
    const router = useRouter();
    const { user, did, handle: userHandle } = useAuth();
    const handle = params.handle as string;
    const id = params.id as string;

    const [post, setPost] = useState<Post | null>(null);
    const [replies, setReplies] = useState<Post[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchPostDetail = async () => {
        try {
            const res = await fetch(`/api/posts/${id}`);
            if (!res.ok) {
                throw new Error('Post not found');
            }
            const data = await res.json();
            setPost(data.post);
            setReplies(data.replies || []);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load post');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchPostDetail();
    }, [id]);

    const handlePost = async (content: string, mediaIds: string[], linkPreview?: any, replyToId?: string, isNsfw?: boolean) => {
        // Check if we're replying to a swarm post
        let swarmReplyTo: { postId: string; nodeDomain: string; content?: string; author?: any } | undefined;
        let localReplyToId: string | undefined = replyToId;

        if (post?.isSwarm && post.nodeDomain && post.originalPostId) {
            // This is a reply to a swarm post - send to the origin node
            swarmReplyTo = {
                postId: post.originalPostId,
                nodeDomain: post.nodeDomain,
                content: post.content,
                author: post.author,
            };
            localReplyToId = undefined; // Can't use UUID foreign key for swarm posts
        }

        if (!did || !userHandle) return;

        const res = await signedAPI.createPost(
            content,
            mediaIds,
            linkPreview,
            localReplyToId,
            swarmReplyTo,
            isNsfw || false,
            did,
            userHandle
        );

        if (res.ok) {
            const data = await res.json();
            // Add the new reply to the top of the list or re-fetch
            setReplies([{ ...data.post, author: user }, ...replies]);
            if (post) {
                setPost({ ...post, repliesCount: post.repliesCount + 1 });
            }
        }
    };

    const handleLike = async (postId: string, currentLiked: boolean) => {
        if (!did || !userHandle) return;
        const res = currentLiked
            ? await signedAPI.unlikePost(postId, did, userHandle)
            : await signedAPI.likePost(postId, did, userHandle);

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Failed to update like');
        }
    };

    const handleRepost = async (postId: string, currentReposted: boolean) => {
        if (!did || !userHandle) return;
        const res = currentReposted
            ? await signedAPI.unrepostPost(postId, did, userHandle)
            : await signedAPI.repostPost(postId, did, userHandle);

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Failed to update repost');
        }
    };

    const handleDelete = (postId: string) => {
        if (postId === id) {
            router.push(`/u/${handle}`);
        } else {
            setReplies(prev => prev.filter(r => r.id !== postId));
            if (post) {
                setPost({ ...post, repliesCount: Math.max(0, post.repliesCount - 1) });
            }
        }
    };

    if (loading) {
        return (
            <div style={{ padding: '48px', textAlign: 'center', color: 'var(--foreground-tertiary)' }}>
                Loading...
            </div>
        );
    }

    if (error || !post) {
        return (
            <div style={{ padding: '48px', textAlign: 'center' }}>
                <h1 style={{ fontSize: '20px', marginBottom: '16px' }}>{error || 'Post not found'}</h1>
                <button className="btn btn-primary" onClick={() => router.back()}>Go Back</button>
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
                background: 'var(--background)',
                zIndex: 10,
                backdropFilter: 'blur(12px)',
                display: 'flex',
                alignItems: 'center',
                gap: '24px',
            }}>
                <button
                    onClick={() => router.back()}
                    style={{ background: 'none', border: 'none', color: 'var(--foreground)', cursor: 'pointer', display: 'flex' }}
                >
                    <ArrowLeftIcon />
                </button>
                <h1 style={{ fontSize: '18px', fontWeight: 600 }}>Post</h1>
            </header>

            <PostCard
                post={post}
                isDetail
                onLike={handleLike}
                onRepost={handleRepost}
                onDelete={handleDelete}
                onComment={() => {
                    const composer = document.querySelector('.compose-input') as HTMLTextAreaElement;
                    composer?.focus();
                }}
            />

            {user && (
                <div style={{ borderBottom: '1px solid var(--border)' }}>
                    <Compose
                        onPost={handlePost}
                        replyingTo={post}
                        isReply
                        placeholder="Post your reply"
                    />
                </div>
            )}

            <div className="replies-list" style={{ paddingBottom: '64px' }}>
                {replies.map((reply) => (
                    <PostCard
                        key={reply.id}
                        post={reply}
                        onLike={handleLike}
                        onRepost={handleRepost}
                        onDelete={handleDelete}
                        parentPostAuthorId={post.author.id}
                        onComment={(p) => {
                            // In detail view, commenting on a reply should probably just focus the main composer
                            // but we could also implement nested replies later. 
                            // For now, let's keep it simple.
                            const composer = document.querySelector('.compose-input') as HTMLTextAreaElement;
                            composer?.focus();
                        }}
                    />
                ))}
            </div>
        </>
    );
}
