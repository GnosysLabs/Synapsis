import { describe, expect, it } from 'vitest';

import {
  CHAT_ATTACHMENT_LIMIT,
  decodeChatMessageContent,
  encodeChatMessageContent,
  getChatMessagePreview,
  type ChatAttachment,
} from './message-content';

function attachment(index: number): ChatAttachment {
  return {
    url: `https://media.example/chat/${index}.png`,
    filename: `photo-${index}.png`,
    mimeType: 'image/png',
    size: 1_024,
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
  });

  it('builds useful previews for attachment-only messages', () => {
    expect(getChatMessagePreview({ text: '', attachments: [attachment(1)] })).toBe('Sent an attachment');
    expect(getChatMessagePreview({ text: '   ', attachments: [attachment(1), attachment(2)] }))
      .toBe('Sent 2 attachments');
  });
});
