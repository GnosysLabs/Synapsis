'use client';

import Image from 'next/image';
import { Download, File, Loader2, LockKeyhole, LockOpen, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AudioPlayer } from '@/components/AudioPlayer';
import {
  isEncryptedChatAttachment,
  type ChatAttachment,
} from '@/lib/chat/message-content';
import { decryptE2EEMediaBlob } from '@/lib/e2ee/media-crypto';
import type { E2EEMediaEncryption } from '@/lib/e2ee/media-format';
import { getMediaKind } from '@/lib/media/upload-policy';
import { primeVideoPreviewFrame } from '@/lib/media/video-preview';

interface ChatMessageAttachmentsProps {
  attachments: ChatAttachment[];
}

const AUTO_DECRYPT_MAX_BYTES = 32 * 1024 * 1024;

function RenderedAttachment({
  attachment,
  src,
  encrypted,
}: {
  attachment: ChatAttachment;
  src: string;
  encrypted: boolean;
}) {
  const kind = getMediaKind(attachment.mimeType);
  const lockBadge = encrypted ? (
    <span
      className="chat-message-attachment-lock"
      title="End-to-end encrypted media"
      aria-label="End-to-end encrypted media"
    >
      <LockKeyhole size={12} aria-hidden="true" />
    </span>
  ) : (
    <span
      className="chat-message-attachment-legacy"
      title="Legacy attachment — not end-to-end encrypted"
      aria-label="Legacy attachment — not end-to-end encrypted"
    >
      <LockOpen size={12} aria-hidden="true" />
    </span>
  );

  if (kind === 'image') {
    return (
      <a
        className="chat-message-attachment visual"
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${attachment.filename}`}
      >
        <Image
          unoptimized
          src={src}
          alt={attachment.filename}
          width={800}
          height={800}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
        {lockBadge}
      </a>
    );
  }

  if (kind === 'video') {
    return (
      <div className="chat-message-attachment visual">
        <video
          src={src}
          controls
          playsInline
          preload="metadata"
          onLoadedMetadata={(event) => primeVideoPreviewFrame(event.currentTarget)}
          aria-label={attachment.filename}
        />
        {lockBadge}
      </div>
    );
  }

  if (kind === 'audio') {
    return (
      <div className="chat-message-attachment audio">
        <AudioPlayer src={src} title={attachment.filename} />
        {lockBadge}
      </div>
    );
  }

  return (
    <a
      className="chat-message-attachment file"
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      download={attachment.filename}
    >
      <File size={18} aria-hidden="true" />
      <span title={attachment.filename}>{attachment.filename}</span>
      <Download size={16} aria-hidden="true" />
      {lockBadge}
    </a>
  );
}

type DecryptionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; src: string }
  | { status: 'failed' };

function EncryptedAttachment({
  attachment,
}: {
  attachment: ChatAttachment & { encryption: E2EEMediaEncryption };
}) {
  const autoDecrypt = attachment.encryption.ciphertextSize <= AUTO_DECRYPT_MAX_BYTES;
  const [state, setState] = useState<DecryptionState>(autoDecrypt
    ? { status: 'loading' }
    : { status: 'idle' });
  const requestRef = useRef<AbortController | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const decrypt = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setState({ status: 'loading' });
    try {
      const response = await fetch(attachment.url, {
        credentials: 'omit',
        mode: 'cors',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Encrypted attachment download failed (${response.status})`);
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength)
        && declaredLength > 0
        && declaredLength !== attachment.encryption.ciphertextSize) {
        throw new Error('Encrypted attachment download size is invalid');
      }
      const ciphertext = await response.blob();
      const plaintext = await decryptE2EEMediaBlob(ciphertext, attachment, controller.signal);
      if (controller.signal.aborted) return;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const src = URL.createObjectURL(plaintext);
      objectUrlRef.current = src;
      setState({ status: 'ready', src });
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error('[E2EE Chat] Attachment could not be decrypted:', error);
      setState({ status: 'failed' });
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, [attachment]);

  useEffect(() => {
    if (autoDecrypt) void decrypt();
    return () => requestRef.current?.abort();
  }, [autoDecrypt, decrypt]);

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
  }, []);

  if (state.status === 'ready') {
    return <RenderedAttachment attachment={attachment} src={state.src} encrypted />;
  }

  return (
    <div className="chat-message-attachment encrypted" role="status">
      <span className="chat-message-encrypted-icon" aria-hidden="true">
        {state.status === 'loading'
          ? <Loader2 size={20} className="animate-spin" />
          : <LockKeyhole size={20} />}
      </span>
      <span className="chat-message-encrypted-copy">
        <strong>{attachment.filename}</strong>
        <span>{state.status === 'loading'
          ? 'Decrypting on this device…'
          : state.status === 'failed'
            ? 'Could not authenticate or decrypt this attachment.'
            : 'End-to-end encrypted media'}</span>
      </span>
      {state.status !== 'loading' && (
        <button type="button" onClick={() => void decrypt()}>
          {state.status === 'failed' ? <RefreshCw size={14} aria-hidden="true" /> : <LockKeyhole size={14} aria-hidden="true" />}
          {state.status === 'failed' ? 'Retry' : 'Decrypt'}
        </button>
      )}
    </div>
  );
}

export function ChatMessageAttachments({ attachments }: ChatMessageAttachmentsProps) {
  if (attachments.length === 0) return null;

  return (
    <div className={`chat-message-attachments ${attachments.length === 1 ? 'single' : ''}`}>
      {attachments.map((attachment, index) => isEncryptedChatAttachment(attachment)
        ? <EncryptedAttachment attachment={attachment} key={`${attachment.url}-${index}`} />
        : (
            <RenderedAttachment
              attachment={attachment}
              src={attachment.url}
              encrypted={false}
              key={`${attachment.url}-${index}`}
            />
          ))}
    </div>
  );
}
