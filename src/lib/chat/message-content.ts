import { z } from 'zod';

import { ALLOWED_MEDIA_TYPES } from '@/lib/media/upload-policy';
import { E2EE_MAX_MESSAGE_PLAINTEXT_BYTES } from '@/lib/e2ee/protocol';
import {
  E2EE_MEDIA_ALGORITHM,
  E2EE_MEDIA_AUTH_TAG_BYTES,
  E2EE_MEDIA_CHUNK_SIZE,
  type E2EEMediaEncryption,
} from '@/lib/e2ee/media-format';
import { accountAddressSchema, federationMediaUrlSchema } from '@/lib/utils/federation';

export const CHAT_ATTACHMENT_LIMIT = 4;
export const CHAT_MESSAGE_TEXT_MAX_BYTES = 8_000;

const chatAttachmentFields = {
  url: federationMediaUrlSchema,
  filename: z.string().trim().min(1).max(255),
  mimeType: z.enum(ALLOWED_MEDIA_TYPES),
  size: z.number().int().positive().safe(),
} as const;

const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const encryptedMediaSchema = z.strictObject({
  version: z.literal(1),
  algorithm: z.literal(E2EE_MEDIA_ALGORITHM),
  key: base64UrlSchema.length(43),
  noncePrefix: base64UrlSchema.length(22),
  mediaId: base64UrlSchema.length(22),
  chunkSize: z.literal(E2EE_MEDIA_CHUNK_SIZE),
  ciphertextSize: z.number().int().positive().safe(),
});

const legacyChatAttachmentSchema = z.strictObject(chatAttachmentFields);
const encryptedChatAttachmentSchema = z.strictObject({
  ...chatAttachmentFields,
  encryption: encryptedMediaSchema,
}).superRefine((attachment, context) => {
  const chunkCount = Math.ceil(attachment.size / attachment.encryption.chunkSize);
  const expectedSize = attachment.size + chunkCount * E2EE_MEDIA_AUTH_TAG_BYTES;
  if (!Number.isSafeInteger(expectedSize)
    || attachment.encryption.ciphertextSize !== expectedSize) {
    context.addIssue({
      code: 'custom',
      path: ['encryption', 'ciphertextSize'],
      message: 'Encrypted attachment size is inconsistent',
    });
  }
});

const chatAttachmentSchema = z.union([
  encryptedChatAttachmentSchema,
  legacyChatAttachmentSchema,
]);

const chatReplyReferenceSchema = z.strictObject({
  messageId: z.string().uuid(),
  // Legacy encrypted payloads cannot be rewritten. New writes are checked in
  // encodeChatMessageContent, while decode accepts their historical bare form.
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

export function isEncryptedChatAttachment(
  attachment: ChatAttachment,
): attachment is ChatAttachment & { encryption: E2EEMediaEncryption } {
  return 'encryption' in attachment;
}

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
  if (content.replyTo && !accountAddressSchema.safeParse(content.replyTo.senderHandle).success) {
    throw new Error('The replied-to account address is invalid. Reload the conversation and try again.');
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
