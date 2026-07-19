'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Pencil, Trash2 } from 'lucide-react';

import { CollectionCover } from '@/components/CollectionCover';
import { CollectionEditorModal } from '@/components/CollectionEditorModal';
import { PostCard } from '@/components/PostCard';
import { signedAPI } from '@/lib/api/signed-fetch';
import type { CollectionDetail, CollectionSummary } from '@/lib/collections/types';
import { useAuth } from '@/lib/contexts/AuthContext';
import { useAppDialog } from '@/lib/contexts/DialogContext';
import type { Post } from '@/lib/types';

export default function CollectionPage() {
  const params = useParams<{ handle: string; collectionId: string }>();
  const router = useRouter();
  const handle = (params.handle || '').replace(/^@/, '');
  const collectionId = params.collectionId || '';
  const { user, did, handle: currentHandle, isIdentityUnlocked } = useAuth();
  const { showConfirm } = useAppDialog();
  const [collection, setCollection] = useState<CollectionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const isOwner = Boolean(user && !handle.includes('@') && user.handle === handle);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetch(
      `/api/users/${encodeURIComponent(handle)}/collections/${encodeURIComponent(collectionId)}`,
      { signal: controller.signal, cache: 'no-store' },
    ).then(async (response) => {
      const data = await response.json().catch(() => ({})) as { collection?: CollectionDetail; nextCursor?: string | null; error?: string };
      if (!response.ok || !data.collection) throw new Error(data.error || 'Collection not found');
      setCollection(data.collection);
      setNextCursor(data.nextCursor || null);
    }).catch((loadError) => {
      if (!controller.signal.aborted) {
        setError(loadError instanceof Error ? loadError.message : 'Collection not found');
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [collectionId, handle]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const response = await fetch(
        `/api/users/${encodeURIComponent(handle)}/collections/${encodeURIComponent(collectionId)}?cursor=${encodeURIComponent(nextCursor)}`,
        { cache: 'no-store' },
      );
      const data = await response.json().catch(() => ({})) as { collection?: CollectionDetail; nextCursor?: string | null; error?: string };
      if (!response.ok || !data.collection) throw new Error(data.error || 'Could not load more posts');
      setCollection((current) => current ? {
        ...current,
        posts: [...current.posts, ...data.collection!.posts.filter((post) => (
          !current.posts.some((existing) => existing.id === post.id)
        ))],
      } : data.collection!);
      setNextCursor(data.nextCursor || null);
    } catch (loadError) {
      setLoadMoreError(loadError instanceof Error ? loadError.message : 'Could not load more posts');
    } finally {
      setLoadingMore(false);
    }
  };

  const handleLike = async (postId: string, currentLiked: boolean) => {
    if (!did || !currentHandle) throw new Error('Please log in again.');
    const response = currentLiked
      ? await signedAPI.unlikePost(postId, did, currentHandle)
      : await signedAPI.likePost(postId, did, currentHandle);
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error || 'Failed to update like');
    }
  };

  const handleRepost = async (postId: string, currentReposted: boolean) => {
    if (!did || !currentHandle) throw new Error('Please log in again.');
    const response = currentReposted
      ? await signedAPI.unrepostPost(postId, did, currentHandle)
      : await signedAPI.repostPost(postId, did, currentHandle);
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error || 'Failed to update repost');
    }
  };

  const handleComment = (post: Post) => {
    router.push(`/u/${post.author.handle}/posts/${post.id}`);
  };

  const deleteCollection = async () => {
    if (!collection || deleting) return;
    if (!isIdentityUnlocked || !did || !currentHandle) {
      setError('Your session expired. Please sign in again.');
      return;
    }
    const confirmed = await showConfirm({
      title: 'Delete collection?',
      message: `“${collection.title}” will be removed from your profile. Its posts will not be deleted.`,
      confirmLabel: 'Delete collection',
      tone: 'danger',
    });
    if (!confirmed) return;

    setDeleting(true);
    try {
      const response = await signedAPI.deleteCollection(handle, collection.id, did, currentHandle);
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error || 'Could not delete collection');
      router.push(`/u/${encodeURIComponent(handle)}?tab=collections`);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Could not delete collection');
      setDeleting(false);
    }
  };

  if (loading) return <div className="collection-detail-state">Loading collection…</div>;
  if (!collection || error) {
    return (
      <div className="collection-detail-state">
        <strong>{error || 'Collection not found'}</strong>
        <Link href={`/u/${encodeURIComponent(handle)}?tab=collections`} className="btn btn-ghost">Back to profile</Link>
      </div>
    );
  }

  return (
    <main className="collection-detail-page">
      <header className="collection-detail-nav">
        <Link href={`/u/${encodeURIComponent(handle)}?tab=collections`} aria-label="Back to collections">
          <ArrowLeft size={20} />
        </Link>
        <div>
          <strong>{collection.title}</strong>
          <span>@{handle}</span>
        </div>
      </header>

      <section className="collection-detail-hero">
        <CollectionCover
          title={collection.title}
          coverUrl={collection.coverUrl}
          previewImages={collection.previewImages}
          className="collection-detail-cover"
        />
        <div className="collection-detail-heading">
          <div>
            <h1>{collection.title}</h1>
            <p className="collection-detail-count">{collection.postCount} {collection.postCount === 1 ? 'post' : 'posts'}</p>
            {collection.description && <p className="collection-detail-description">{collection.description}</p>}
          </div>
          {isOwner && (
            <div className="collection-detail-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
                <Pencil size={16} /> Edit
              </button>
              <button type="button" className="btn btn-ghost btn-sm collection-delete-button" onClick={deleteCollection} disabled={deleting}>
                <Trash2 size={16} /> {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          )}
        </div>
      </section>

      {collection.posts.length === 0 ? (
        <div className="collection-state collection-empty-state">
          <strong>No posts in this collection</strong>
          <span>{isOwner ? 'Use the … menu on one of your posts to add it here.' : 'There is nothing here yet.'}</span>
        </div>
      ) : collection.posts.map((post) => (
        <PostCard
          key={post.id}
          post={post}
          onLike={handleLike}
          onRepost={handleRepost}
          onComment={handleComment}
          onDelete={(postId) => setCollection((current) => current ? {
            ...current,
            postCount: Math.max(0, current.postCount - 1),
            posts: current.posts.filter((item) => item.id !== postId),
          } : current)}
          onCollectionsChanged={(collectionIds) => {
            if (collectionIds.includes(collection.id)) return;
            setCollection((current) => current ? {
              ...current,
              postCount: Math.max(0, current.postCount - 1),
              posts: current.posts.filter((item) => item.id !== post.id),
            } : current);
          }}
        />
      ))}

      {nextCursor && (
        <div className="collection-load-more">
          <button type="button" className="btn btn-ghost" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more posts'}
          </button>
          {loadMoreError && <span role="alert">{loadMoreError}</span>}
        </div>
      )}

      {editing && (
        <CollectionEditorModal
          handle={handle}
          collection={collection as CollectionSummary}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setCollection((current) => current ? { ...current, ...saved } : current);
            setEditing(false);
          }}
        />
      )}
    </main>
  );
}
