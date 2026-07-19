'use client';

import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderPlus, Loader2, X } from 'lucide-react';

import { CollectionCover } from '@/components/CollectionCover';
import { CollectionEditorModal } from '@/components/CollectionEditorModal';
import { signedAPI } from '@/lib/api/signed-fetch';
import type { CollectionSummary, PostCollectionChoice } from '@/lib/collections/types';
import { useAuth } from '@/lib/contexts/AuthContext';

interface PostCollectionPickerProps {
  postId: string;
  onClose: () => void;
  onSaved?: (collectionIds: string[]) => void;
}

export function PostCollectionPicker({ postId, onClose, onSaved }: PostCollectionPickerProps) {
  const { did, handle, isIdentityUnlocked } = useAuth();
  const [collections, setCollections] = useState<PostCollectionChoice[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/posts/${postId}/collections`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { collections?: PostCollectionChoice[]; error?: string };
        if (!response.ok) throw new Error(data.error || 'Could not load collections');
        const choices = data.collections || [];
        setCollections(choices);
        setSelected(new Set(choices.filter((choice) => choice.containsPost).map((choice) => choice.id)));
      })
      .catch((loadError) => {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : 'Could not load collections');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [postId]);

  const save = async () => {
    if (saving) return;
    if (!isIdentityUnlocked || !did || !handle) {
      setError('Your session expired. Please sign in again.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await signedAPI.updatePostCollections(postId, [...selected], did, handle);
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error || 'Could not update collections');
      onSaved?.([...selected]);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not update collections');
    } finally {
      setSaving(false);
    }
  };

  if (typeof document === 'undefined') return null;
  return (
    <>
      {createPortal(
        <div className="app-dialog-backdrop collection-modal-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !saving) onClose();
        }}>
          <div className="app-dialog post-collection-picker" role="dialog" aria-modal="true" aria-labelledby={titleId}>
            <button type="button" className="app-dialog-close" onClick={onClose} disabled={saving} aria-label="Close">
              <X size={20} />
            </button>
            <div className="app-dialog-heading">
              <div className="app-dialog-icon"><FolderPlus size={20} /></div>
              <div>
                <h2 id={titleId}>Add to collection</h2>
                <p>A post can appear in more than one collection.</p>
              </div>
            </div>

            <div className="post-collection-picker-body">
              {loading ? (
                <div className="collection-state"><Loader2 className="animate-spin" size={22} /> Loading…</div>
              ) : collections.length === 0 ? (
                <div className="collection-state">You do not have any collections yet.</div>
              ) : (
                <div className="post-collection-options">
                  {collections.map((collection) => (
                    <label className="post-collection-option" key={collection.id}>
                      <input
                        type="checkbox"
                        checked={selected.has(collection.id)}
                        onChange={() => setSelected((current) => {
                          const next = new Set(current);
                          if (next.has(collection.id)) next.delete(collection.id);
                          else next.add(collection.id);
                          return next;
                        })}
                      />
                      <CollectionCover
                        title={collection.title}
                        coverUrl={collection.coverUrl}
                        previewImages={collection.previewImages}
                        className="post-collection-option-cover"
                      />
                      <span>
                        <strong>{collection.title}</strong>
                        <small>{collection.postCount} {collection.postCount === 1 ? 'post' : 'posts'}</small>
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {error && <div className="collection-form-error" role="alert">{error}</div>}
            </div>

            <div className="app-dialog-actions post-collection-picker-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setCreating(true)} disabled={saving}>
                <FolderPlus size={16} /> New collection
              </button>
              <span className="post-collection-picker-spacer" />
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={save} disabled={saving || loading}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {creating && handle && (
        <CollectionEditorModal
          handle={handle}
          initialPostId={postId}
          onClose={() => setCreating(false)}
          onSaved={(created: CollectionSummary) => {
            setCollections((current) => [...current, { ...created, containsPost: true }]);
            setSelected((current) => new Set(current).add(created.id));
            setCreating(false);
            onSaved?.([...selected, created.id]);
          }}
        />
      )}
    </>
  );
}
