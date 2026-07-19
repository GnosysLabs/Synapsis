'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { FolderPlus, Pencil } from 'lucide-react';

import { CollectionCover } from '@/components/CollectionCover';
import { CollectionEditorModal } from '@/components/CollectionEditorModal';
import type { CollectionSummary } from '@/lib/collections/types';
import { useAuth } from '@/lib/contexts/AuthContext';

interface CollectionGridProps {
  handle: string;
}

export function CollectionGrid({ handle }: CollectionGridProps) {
  const { user } = useAuth();
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CollectionSummary | 'new' | null>(null);
  const isOwner = Boolean(user && !handle.includes('@') && user.handle === handle.replace(/^@/, ''));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(handle)}/collections`, { cache: 'no-store' });
      const data = await response.json().catch(() => ({})) as { collections?: CollectionSummary[]; error?: string };
      if (!response.ok) throw new Error(data.error || 'Could not load collections');
      setCollections(data.collections || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load collections');
    } finally {
      setLoading(false);
    }
  }, [handle]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <div className="collection-state">Loading collections…</div>;
  }

  return (
    <section className="collections-section">
      {isOwner && (
        <div className="collections-toolbar">
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
            <FolderPlus size={17} /> New collection
          </button>
        </div>
      )}
      {error ? (
        <div className="collection-state" role="alert">{error}</div>
      ) : collections.length === 0 ? (
        <div className="collection-state collection-empty-state">
          <FolderPlus size={32} aria-hidden="true" />
          <strong>No collections yet</strong>
          <span>{isOwner ? 'Create one to organize posts on your profile.' : 'This user has not created any collections.'}</span>
        </div>
      ) : (
        <div className="collection-grid">
          {collections.map((collection) => (
            <div className="collection-card-wrap" key={collection.id}>
              <Link
                href={`/u/${encodeURIComponent(handle)}/collections/${collection.id}`}
                className="collection-card"
              >
                <CollectionCover
                  title={collection.title}
                  coverUrl={collection.coverUrl}
                  previewImages={collection.previewImages}
                />
                <div className="collection-card-content">
                  <strong>{collection.title}</strong>
                  <span>{collection.postCount} {collection.postCount === 1 ? 'post' : 'posts'}</span>
                  {collection.description && <p>{collection.description}</p>}
                </div>
              </Link>
              {isOwner && (
                <button
                  type="button"
                  className="collection-card-edit"
                  onClick={() => setEditing(collection)}
                  aria-label={`Edit ${collection.title}`}
                >
                  <Pencil size={16} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {editing && (
        <CollectionEditorModal
          handle={handle}
          collection={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setCollections((current) => {
              const existingIndex = current.findIndex((item) => item.id === saved.id);
              if (existingIndex === -1) return [saved, ...current];
              return current.map((item) => item.id === saved.id ? saved : item);
            });
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}
