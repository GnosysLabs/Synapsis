'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderPlus, X } from 'lucide-react';

import { UserStorageImageUpload } from '@/components/UserStorageImageUpload';
import { signedAPI } from '@/lib/api/signed-fetch';
import { useAuth } from '@/lib/contexts/AuthContext';
import type { CollectionSummary } from '@/lib/collections/types';

interface CollectionEditorModalProps {
  handle: string;
  collection?: CollectionSummary | null;
  initialPostId?: string;
  onClose: () => void;
  onSaved: (collection: CollectionSummary) => void;
}

export function CollectionEditorModal({
  handle,
  collection,
  initialPostId,
  onClose,
  onSaved,
}: CollectionEditorModalProps) {
  const { did, handle: currentHandle, isIdentityUnlocked } = useAuth();
  const [title, setTitle] = useState(collection?.title || '');
  const [description, setDescription] = useState(collection?.description || '');
  const [coverUrl, setCoverUrl] = useState(collection?.coverUrl || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    inputRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, saving]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle || saving) return;
    if (!isIdentityUnlocked || !did || !currentHandle) {
      setError('Your session expired. Please sign in again.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const fields = {
        title: trimmedTitle,
        description: description.trim() || null,
        coverUrl: coverUrl || null,
      };
      const response = collection
        ? await signedAPI.updateCollection(handle, collection.id, fields, did, currentHandle)
        : await signedAPI.createCollection(
          handle,
          { ...fields, postIds: initialPostId ? [initialPostId] : [] },
          did,
          currentHandle,
        );
      const data = await response.json().catch(() => ({})) as {
        collection?: CollectionSummary;
        error?: string;
      };
      if (!response.ok || !data.collection) {
        throw new Error(data.error || 'Unable to save collection');
      }
      onSaved(data.collection);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save collection');
    } finally {
      setSaving(false);
    }
  };

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="app-dialog-backdrop collection-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <div ref={dialogRef} className="app-dialog collection-editor" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <button type="button" className="app-dialog-close" onClick={onClose} disabled={saving} aria-label="Close">
          <X size={20} />
        </button>
        <div className="app-dialog-heading">
          <div className="app-dialog-icon"><FolderPlus size={20} /></div>
          <div>
            <h2 id={titleId}>{collection ? 'Edit collection' : 'New collection'}</h2>
            <p>Group posts into a public collection on your profile.</p>
          </div>
        </div>
        <form className="app-dialog-form" onSubmit={save}>
          <label className="app-dialog-field">
            <span>Title</span>
            <input
              ref={inputRef}
              className="input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={80}
              placeholder="Photography, Projects, Favorites…"
              required
            />
          </label>
          <label className="app-dialog-field">
            <span>Description <small>Optional</small></span>
            <textarea
              className="input collection-description-input"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={240}
              rows={3}
              placeholder="What belongs in this collection?"
            />
          </label>
          <UserStorageImageUpload
            label="Cover"
            value={coverUrl}
            onChange={setCoverUrl}
            helperText="Wide image recommended. If omitted, Synapsis uses recent post media."
            previewWidth={144}
            previewHeight={81}
            onError={(message) => setError(message || null)}
          />
          {error && <div className="collection-form-error" role="alert">{error}</div>}
          <div className="app-dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving || !title.trim()}>
              {saving ? 'Saving…' : collection ? 'Save changes' : 'Create collection'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
