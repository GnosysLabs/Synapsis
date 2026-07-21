import { describe, expect, it } from 'vitest';

import {
  CHAT_ATTACHMENT_LIMIT,
  decodeChatMessageContent,
  encodeChatMessageContent,
  getChatMessagePreview,
  type ChatAttachment,
} from './message-content';
import type { E2EEMediaEncryption } from '@/lib/e2ee/media-format';

function attachment(index: number): ChatAttachment {
  return {
    url: `https://stuffbox.xyz/chat/${index}.png`,
    filename: `photo-${index}.png`,
    mimeType: 'image/png',
    size: 1_024,
  };
}

function encryptedAttachment(
  index: number,
): ChatAttachment & { encryption: E2EEMediaEncryption } {
  return {
    ...attachment(index),
    encryption: {
      version: 1,
      algorithm: 'xchacha20-poly1305-ietf-chunked',
      key: 'A'.repeat(43),
      noncePrefix: 'B'.repeat(22),
      mediaId: 'C'.repeat(22),
      chunkSize: 1024 * 1024,
      ciphertextSize: 1_040,
    },
  };
}

describe('encrypted chat message content', () => {
  it('round-trips text and four attachments', () => {
    const content = {
      text: 'Look at these',
      attachments: Array.from({ length: CHAT_ATTACHMENT_LIMIT }, (_, index) => attachment(index)),
    };

    expect(decodeChatMessageContent(encodeChatMessageContent(content))).toEqual(content);
  });

  it('round-trips the file key and authenticated chunk descriptor inside the encrypted message', () => {
    const content = { text: '', attachments: [encryptedAttachment(1)] };

    expect(decodeChatMessageContent(encodeChatMessageContent(content))).toEqual(content);
  });

  it('accepts large attachment metadata so Stuffbox quota remains the limit', () => {
    const content = {
      text: '',
      attachments: [{ ...attachment(1), size: 8 * 1024 * 1024 * 1024 }],
    };

    expect(decodeChatMessageContent(encodeChatMessageContent(content))).toEqual(content);
  });

  it('round-trips an encrypted reply reference', () => {
    const content = {
      text: 'Exactly',
      attachments: [],
      replyTo: {
        messageId: '15f11861-693a-4f70-8480-5d82bb8d14a7',
        senderHandle: 'friend@remote.example',
        senderDisplayName: 'Friend',
        preview: 'The original encrypted message',
      },
    };

    expect(decodeChatMessageContent(encodeChatMessageContent(content))).toEqual(content);
  });

  it('keeps existing text-only encrypted messages backward compatible', () => {
    expect(decodeChatMessageContent('a message from before attachments')).toEqual({
      text: 'a message from before attachments',
      attachments: [],
    });
    expect(decodeChatMessageContent('{"an":"old JSON message"}')).toEqual({
      text: '{"an":"old JSON message"}',
      attachments: [],
    });
  });

  it('rejects more than four attachments and unsafe URLs', () => {
    expect(() => encodeChatMessageContent({
      text: '',
      attachments: Array.from({ length: CHAT_ATTACHMENT_LIMIT + 1 }, (_, index) => attachment(index)),
    })).toThrow(/invalid/i);
    expect(() => encodeChatMessageContent({
      text: '',
      attachments: [{ ...attachment(1), url: 'javascript:alert(1)' }],
    })).toThrow(/invalid/i);
    expect(() => encodeChatMessageContent({
      text: 'Reply',
      attachments: [],
      replyTo: {
        messageId: 'not-a-message-id',
        senderHandle: 'friend',
        senderDisplayName: 'Friend',
        preview: 'Original',
      },
    })).toThrow(/invalid/i);
  });

  it('rejects inconsistent encrypted attachment sizes', () => {
    expect(() => encodeChatMessageContent({
      text: '',
      attachments: [{
        ...encryptedAttachment(1),
        encryption: {
          ...encryptedAttachment(1).encryption,
          ciphertextSize: 1_039,
        },
      }],
    })).toThrow(/invalid/i);
  });

  it('builds useful previews for attachment-only messages', () => {
    expect(getChatMessagePreview({ text: '', attachments: [attachment(1)] })).toBe('Sent an attachment');
    expect(getChatMessagePreview({ text: '   ', attachments: [attachment(1), attachment(2)] }))
      .toBe('Sent 2 attachments');
  });
});
