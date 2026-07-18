import { z } from 'zod';

import { ALLOWED_MEDIA_TYPES, getMaxMediaSize } from '@/lib/media/upload-policy';
import { E2EE_MAX_MESSAGE_PLAINTEXT_BYTES } from '@/lib/e2ee/protocol';

export const CHAT_ATTACHMENT_LIMIT = 4;
export const CHAT_MESSAGE_TEXT_MAX_BYTES = 8_000;

const chatAttachmentSchema = z.strictObject({
  url: z.string().url().max(4_096).refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === 'https:' || protocol === 'http:';
    } catch {
      return false;
    }
  }, 'Attachment URLs must use HTTP or HTTPS'),
  filename: z.string().trim().min(1).max(255),
  mimeType: z.enum(ALLOWED_MEDIA_TYPES),
  size: z.number().int().positive().max(100 * 1024 * 1024),
}).superRefine((attachment, context) => {
  const maximum = getMaxMediaSize(attachment.mimeType);
  if (maximum !== null && attachment.size > maximum) {
    context.addIssue({
      code: 'too_big',
      maximum,
      origin: 'number',
      inclusive: true,
      path: ['size'],
      message: 'Attachment exceeds the allowed size',
    });
  }
});

const chatReplyReferenceSchema = z.strictObject({
  messageId: z.string().uuid(),
  senderHandle: z.string().trim().min(1).max(640),
  senderDisplayName: z.string().trim().min(1).max(160).nullable(),
  preview: z.string().trim().min(1).max(160),
});

const encryptedChatContentSchema = z.strictObject({
  type: z.literal('synapsis-chat-message'),
  version: z.literal(1),
  text: z.string(),
  attachments: z.array(chatAttachmentSchema).max(CHAT_ATTACHMENT_LIMIT),
  replyTo: chatReplyReferenceSchema.optional(),
});

export type ChatAttachment = z.infer<typeof chatAttachmentSchema>;
export type ChatReplyReference = z.infer<typeof chatReplyReferenceSchema>;

export interface ChatMessageContent {
  text: string;
  attachments: ChatAttachment[];
  replyTo?: ChatReplyReference | null;
}

function assertContentSize(content: ChatMessageContent, encoded: string): void {
  if (new TextEncoder().encode(content.text).length > CHAT_MESSAGE_TEXT_MAX_BYTES) {
    throw new Error(`Encrypted message text can be up to ${CHAT_MESSAGE_TEXT_MAX_BYTES.toLocaleString()} bytes.`);
  }
  if (new TextEncoder().encode(encoded).length > E2EE_MAX_MESSAGE_PLAINTEXT_BYTES) {
    throw new Error('This encrypted message is too large. Shorten the text or remove an attachment.');
  }
}

export function encodeChatMessageContent(content: ChatMessageContent): string {
  if (!content.text.trim() && content.attachments.length === 0) {
    throw new Error('Add a message or an attachment before sending.');
  }

  const parsed = encryptedChatContentSchema.safeParse({
    type: 'synapsis-chat-message',
    version: 1,
    text: content.text,
    attachments: content.attachments,
    ...(content.replyTo ? { replyTo: content.replyTo } : {}),
  });
  if (!parsed.success) {
    throw new Error('One or more chat attachments are invalid. Remove them and try again.');
  }

  const encoded = JSON.stringify(parsed.data);
  assertContentSize(content, encoded);
  return encoded;
}

export function decodeChatMessageContent(plaintext: string): ChatMessageContent {
  let candidate: unknown;
  try {
    candidate = JSON.parse(plaintext);
  } catch {
    return { text: plaintext, attachments: [] };
  }

  if (!candidate || typeof candidate !== 'object'
    || !('type' in candidate)
    || candidate.type !== 'synapsis-chat-message'
    || !('version' in candidate)
    || candidate.version !== 1) {
    return { text: plaintext, attachments: [] };
  }

  const parsed = encryptedChatContentSchema.safeParse(candidate);
  if (!parsed.success) throw new Error('Encrypted chat content is invalid');
  assertContentSize({ text: parsed.data.text, attachments: parsed.data.attachments }, plaintext);
  return {
    text: parsed.data.text,
    attachments: parsed.data.attachments,
    ...(parsed.data.replyTo ? { replyTo: parsed.data.replyTo } : {}),
  };
}

export function getChatMessagePreview(content: ChatMessageContent): string {
  const normalized = content.text.replace(/\s+/g, ' ').trim();
  if (normalized) {
    const characters = Array.from(normalized);
    return characters.length > 96
      ? `${characters.slice(0, 96).join('')}…`
      : normalized;
  }

  if (content.attachments.length === 1) return 'Sent an attachment';
  if (content.attachments.length > 1) return `Sent ${content.attachments.length} attachments`;
  return 'Encrypted message';
}
