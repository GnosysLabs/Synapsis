'use client';

import Image from 'next/image';
import { Download, File } from 'lucide-react';

import { AudioPlayer } from '@/components/AudioPlayer';
import type { ChatAttachment } from '@/lib/chat/message-content';
import { getMediaKind } from '@/lib/media/upload-policy';
import { primeVideoPreviewFrame } from '@/lib/media/video-preview';

interface ChatMessageAttachmentsProps {
  attachments: ChatAttachment[];
}

export function ChatMessageAttachments({ attachments }: ChatMessageAttachmentsProps) {
  if (attachments.length === 0) return null;

  return (
    <div className={`chat-message-attachments ${attachments.length === 1 ? 'single' : ''}`}>
      {attachments.map((attachment, index) => {
        const kind = getMediaKind(attachment.mimeType);
        const key = `${attachment.url}-${index}`;

        if (kind === 'image') {
          return (
            <a
              className="chat-message-attachment visual"
              href={attachment.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${attachment.filename}`}
              key={key}
            >
              <Image
                unoptimized
                src={attachment.url}
                alt={attachment.filename}
                width={800}
                height={800}
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            </a>
          );
        }

        if (kind === 'video') {
          return (
            <div className="chat-message-attachment visual" key={key}>
              <video
                src={attachment.url}
                controls
                playsInline
                preload="metadata"
                onLoadedMetadata={(event) => primeVideoPreviewFrame(event.currentTarget)}
                aria-label={attachment.filename}
              />
            </div>
          );
        }

        if (kind === 'audio') {
          return (
            <div className="chat-message-attachment audio" key={key}>
              <AudioPlayer src={attachment.url} title={attachment.filename} />
            </div>
          );
        }

        return (
          <a
            className="chat-message-attachment file"
            href={attachment.url}
            target="_blank"
            rel="noopener noreferrer"
            download={attachment.filename}
            key={key}
          >
            <File size={18} aria-hidden="true" />
            <span title={attachment.filename}>{attachment.filename}</span>
            <Download size={16} aria-hidden="true" />
          </a>
        );
      })}
    </div>
  );
}
