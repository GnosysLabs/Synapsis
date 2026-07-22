'use client';

import { Fragment, useCallback, useState, useEffect, useLayoutEffect, useRef } from 'react';
import Image from 'next/image';
import { useAuth } from '@/lib/contexts/AuthContext';
import { signedAPI } from '@/lib/api/signed-fetch';
import { ArrowLeft, Send, Loader2, LockKeyhole, MessageCircle, Music2, Paperclip, Reply as ReplyIcon, Search, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { getProfilePath, isHandleOnNode, sameAccountHandle, useFormattedHandle } from '@/lib/utils/handle';
import { useRouter, useSearchParams } from 'next/navigation';
import { AvatarImage } from '@/components/AvatarImage';
import { StuffboxBadge } from '@/components/StuffboxBadge';
import { E2EEChatGate } from '@/components/E2EEChatGate';
import {
    decryptStoredChatMessage,
    E2EEClientError,
    resolveE2EEPublicBundle,
    type StoredChatMessage,
} from '@/lib/e2ee/client';
import { encryptE2EEMessage } from '@/lib/e2ee/client-crypto';
import type { E2EEKeyBundle, E2EEKeyMaterial, E2EEMessageEnvelope } from '@/lib/e2ee/protocol';
import { useE2EEIdentity } from '@/lib/e2ee/use-e2ee-identity';
import { ChatRecipientPicker } from '@/components/ChatRecipientPicker';
import { ChatMessageAttachments } from '@/components/ChatMessageAttachments';
import { ChatPostCard } from '@/components/ChatPostCard';
import { StorageConfigurationPrompt } from '@/components/StorageConfigurationPrompt';
import { getStorageProvider, MediaUploadError, uploadEncryptedMediaFile } from '@/lib/stuffbox/browser-upload';
import { getMediaKind } from '@/lib/media/upload-policy';
import { primeVideoPreviewFrame } from '@/lib/media/video-preview';
import {
    CHAT_ATTACHMENT_LIMIT,
    encodeChatMessageContent,
    getChatMessagePreview,
    type ChatAttachment,
    type ChatReplyReference,
} from '@/lib/chat/message-content';
import { getEmojiOnlyCount } from '@/lib/chat/emoji-only';
import { findChatPostLinks, removeChatPostLinks, uniqueChatPostLinks } from '@/lib/chat/post-links';
import { useDomain } from '@/lib/contexts/ConfigContext';
import {
    buildChatShareContinuationHref,
    buildChatShareHref,
} from '@/lib/chat/recipients';
import {
    canonicalAccountAddress,
    displayAccountAddress,
    resolveAccountAddress,
} from '@/lib/identity/account-address';
import type { StuffboxBadge as StuffboxBadgeValue } from '@/lib/types';
import { useProfilePresentationRegistry } from '@/lib/contexts/ProfilePresentationContext';

interface Conversation {
    id: string;
    nodeBlocked: boolean;
    participant2: {
        handle: string;
        displayName: string;
        avatarUrl: string | null;
        did?: string; // Add DID support
        nodeDomain?: string | null;
        isNsfw?: boolean;
        nodeIsNsfw?: boolean;
        stuffboxBadge?: StuffboxBadgeValue | null;
        profilePresentationVerified?: boolean;
        profileVersion?: number | null;
    };
    lastMessageAt: string;
    lastMessagePreview: string;
    lastMessage?: StoredChatMessage | null;
    unreadCount: number;
    encryptionMode?: 'legacy' | 'e2ee';
    e2eeActivatedAt?: string | null;
}


interface ChatMessagePayload extends StoredChatMessage {
    id: string;
    clientMessageId?: string | null;
    senderHandle: string;
    senderDisplayName?: string;
    senderAvatarUrl?: string | null;
    senderNodeDomain?: string | null;
    senderNodeBlocked: boolean;
    senderIsNsfw?: boolean;
    senderNodeIsNsfw?: boolean;
    senderProfilePresentationVerified?: boolean;
    senderProfileVersion?: number | null;
    senderDid?: string;
    isSentByMe: boolean;
    deliveredAt?: string;
    readAt?: string;
    createdAt: string;
}

type Message = Omit<ChatMessagePayload, 'content'> & {
    content: string;
    attachments: ChatAttachment[];
    replyTo: ChatReplyReference | null;
    legacy: boolean;
    decryptionError: boolean;
};

type ChatComposerAttachment = ChatAttachment & {
    id: string;
    previewUrl: string;
    file?: File;
    uploadState: 'uploading' | 'ready' | 'failed';
    uploadProgress: number;
};

interface PendingChatUpload {
    conversationKey: string;
    id: string;
    file: File;
}

type ConversationEncryptionState =
    | { status: 'idle' }
    | { status: 'resolving'; conversationKey: string }
    | {
        status: 'ready';
        conversationKey: string;
        recipientDid: string;
        senderBundle: E2EEKeyBundle;
        recipientBundle: E2EEKeyBundle;
    }
    | { status: 'error'; conversationKey: string; code: string; message: string };

interface ComposeIntentError {
    handle: string;
    message: string;
}

const CHAT_REQUEST_TIMEOUT_MS = 15_000;
const CHAT_COMPOSER_MAX_HEIGHT_PX = 140;

interface PreparedSend {
    accountDid: string;
    conversationKey: string;
    plaintext: string;
    senderKeyId: string;
    recipientKeyId: string;
    envelope: E2EEMessageEnvelope;
}

function encryptionConversationKey(conversation: Conversation): string {
    return `${conversation.id}:${conversation.participant2.did || conversation.participant2.handle}`;
}

function normalizeConversation(conversation: Conversation, localDomain: string): Conversation | null {
    const address = resolveAccountAddress(
        conversation.participant2.handle,
        conversation.participant2.nodeDomain || localDomain,
    );
    if (!address) return null;
    return {
        ...conversation,
        nodeBlocked: conversation.nodeBlocked === true,
        participant2: {
            ...conversation.participant2,
            handle: address.canonical,
            nodeDomain: address.homeDomain,
        },
    };
}

function accountConversationKey(accountDid: string | null, conversationKey: string): string {
    return JSON.stringify([accountDid, conversationKey]);
}

function chatMessageReferenceId(message: Pick<Message, 'id' | 'clientMessageId'>): string {
    return message.clientMessageId || message.id;
}

function getReplyPreview(message: Message, domain: string): string {
    if (message.decryptionError) return 'Encrypted message unavailable';
    const postLinks = findChatPostLinks(message.content, domain);
    const previewText = removeChatPostLinks(message.content, postLinks);
    if (postLinks.length > 0 && !previewText) {
        return uniqueChatPostLinks(postLinks).length > 1 ? 'Shared posts' : 'Shared a post';
    }
    return getChatMessagePreview({ text: previewText, attachments: message.attachments });
}

function resizeChatComposer(input: HTMLTextAreaElement): void {
    input.style.height = 'auto';
    const borderHeight = input.offsetHeight - input.clientHeight;
    const contentHeight = input.scrollHeight + borderHeight;
    input.style.height = `${Math.min(contentHeight, CHAT_COMPOSER_MAX_HEIGHT_PX)}px`;
    input.style.overflowY = contentHeight > CHAT_COMPOSER_MAX_HEIGHT_PX ? 'auto' : 'hidden';
}

export default function ChatPage() {
    const { user, loading: authLoading, isIdentityUnlocked, isRestoring: isIdentityRestoring } = useAuth();
    const router = useRouter();
    const domain = useDomain();
    const { getPresentation, publishVerifiedPresentation } = useProfilePresentationRegistry();
    const searchParams = useSearchParams();
    const composeHandle = canonicalAccountAddress(searchParams.get('compose') || '', domain);
    const sharedPostUrl = searchParams.get('share');
    const e2eeIdentity = useE2EEIdentity(user?.did, user?.handle);
    const activeE2EEKeyId = e2eeIdentity.state.status === 'ready'
        ? e2eeIdentity.state.material.keyId
        : null;

    // Chat Data State
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
    const selectedHandle = useFormattedHandle(
        selectedConversation?.participant2.handle || '',
        selectedConversation?.participant2.nodeDomain,
    );
    const [messages, setMessages] = useState<Message[]>([]);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [replyDrafts, setReplyDrafts] = useState<Record<string, ChatReplyReference>>({});
    const [attachmentDrafts, setAttachmentDrafts] = useState<Record<string, ChatComposerAttachment[]>>({});
    const [attachmentErrors, setAttachmentErrors] = useState<Record<string, string>>({});
    const [storageNotices, setStorageNotices] = useState<Record<string, string>>({});
    const [pendingStorageUploads, setPendingStorageUploads] = useState<PendingChatUpload[]>([]);
    const [showStorageConfiguration, setShowStorageConfiguration] = useState(false);
    const [loading, setLoading] = useState(true);
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState<string | null>(null);
    const [conversationsError, setConversationsError] = useState<string | null>(null);
    const [messagesError, setMessagesError] = useState<string | null>(null);
    const [composeIntentError, setComposeIntentError] = useState<ComposeIntentError | null>(null);
    const [dismissedComposeHandle, setDismissedComposeHandle] = useState<string | null>(null);
    const [composeRetryVersion, setComposeRetryVersion] = useState(0);
    const [conversationEncryption, setConversationEncryption] = useState<ConversationEncryptionState>({ status: 'idle' });
    const [searchQuery, setSearchQuery] = useState('');
    const [loadingMessages, setLoadingMessages] = useState(false);
    const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);

    // Legacy / V2 Hybrid State
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [conversationToDelete, setConversationToDelete] = useState<Conversation | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const messageInputRef = useRef<HTMLTextAreaElement>(null);
    const mediaInputRef = useRef<HTMLInputElement>(null);
    const storageCheckInFlightRef = useRef(false);
    const messageElementsRef = useRef(new Map<string, HTMLDivElement>());
    const highlightTimeoutRef = useRef<number | null>(null);
    const attachmentDraftsRef = useRef<Record<string, ChatComposerAttachment[]>>({});
    const [isAtBottom, setIsAtBottom] = useState(true);
    const appliedSharedPostRef = useRef<string | null>(null);
    const messagesRequestRef = useRef(0);
    const initialScrollConversationKeyRef = useRef<string | null>(null);
    const suppressSmoothScrollRef = useRef(false);
    const conversationsRequestRef = useRef(0);
    const conversationsAbortRef = useRef<AbortController | null>(null);
    const peerResolutionRef = useRef(0);
    const participantPresentationRefreshRef = useRef(0);
    const composeRequestRef = useRef(0);
    const sendRequestRef = useRef(0);
    const accountDidRef = useRef<string | null>(null);
    const renderedAccountDidRef = useRef<string | null>(user?.did ?? null);
    const selectedConversationRef = useRef<Conversation | null>(selectedConversation);
    const selectedConversationKeyRef = useRef<string | null>(null);
    const preparedSendsRef = useRef(new Map<string, PreparedSend>());
    const activeSendKeysRef = useRef(new Set<string>());
    const e2eeMaterialRef = useRef<{ accountDid: string; material: E2EEKeyMaterial } | null>(null);
    const setMessageInputRef = useCallback((input: HTMLTextAreaElement | null) => {
        messageInputRef.current = input;
        if (input) resizeChatComposer(input);
    }, []);

    renderedAccountDidRef.current = user?.did ?? null;
    attachmentDraftsRef.current = attachmentDrafts;
    e2eeMaterialRef.current = user?.did && e2eeIdentity.state.status === 'ready'
        ? { accountDid: user.did, material: e2eeIdentity.state.material }
        : null;
    selectedConversationRef.current = selectedConversation;
    selectedConversationKeyRef.current = selectedConversation
        ? encryptionConversationKey(selectedConversation)
        : null;

    const selectedConversationKey = selectedConversationKeyRef.current;
    const newMessage = selectedConversationKey ? drafts[selectedConversationKey] || '' : '';
    const selectedReply = selectedConversationKey ? replyDrafts[selectedConversationKey] || null : null;
    const selectedAttachments = selectedConversationKey ? attachmentDrafts[selectedConversationKey] || [] : [];
    const selectedAttachmentError = selectedConversationKey ? attachmentErrors[selectedConversationKey] || null : null;
    const selectedStorageNotice = selectedConversationKey ? storageNotices[selectedConversationKey] || null : null;
    const hasUnreadyAttachments = selectedAttachments.some((attachment) => attachment.uploadState !== 'ready');
    const selectedNodeBlocked = selectedConversation?.nodeBlocked === true;
    const canSendMessage = Boolean(newMessage.trim() || selectedAttachments.length > 0)
        && !hasUnreadyAttachments
        && !selectedNodeBlocked;
    const loadedMessageIds = new Set(messages.map(chatMessageReferenceId));

    const updateSelectedDraft = useCallback((value: string) => {
        const key = selectedConversationKeyRef.current;
        if (!key) return;
        const cacheKey = accountConversationKey(renderedAccountDidRef.current, key);
        preparedSendsRef.current.delete(cacheKey);
        setDrafts((current) => current[key] === value ? current : { ...current, [key]: value });
        setSendError(null);
    }, []);

    const updateSelectedReply = useCallback((replyTo: ChatReplyReference | null) => {
        const key = selectedConversationKeyRef.current;
        if (!key) return;
        preparedSendsRef.current.delete(accountConversationKey(renderedAccountDidRef.current, key));
        setReplyDrafts((current) => {
            const next = { ...current };
            if (replyTo) next[key] = replyTo;
            else delete next[key];
            return next;
        });
        setSendError(null);
        if (replyTo) window.requestAnimationFrame(() => messageInputRef.current?.focus());
    }, []);

    const handleReplyToMessage = useCallback((message: Message) => {
        updateSelectedReply({
            messageId: chatMessageReferenceId(message),
            senderHandle: message.senderHandle,
            senderDisplayName: message.senderDisplayName?.trim() || null,
            preview: getReplyPreview(message, domain),
        });
    }, [domain, updateSelectedReply]);

    const jumpToMessage = useCallback((messageId: string) => {
        const target = messageElementsRef.current.get(messageId);
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setHighlightedMessageId(messageId);
        if (highlightTimeoutRef.current !== null) window.clearTimeout(highlightTimeoutRef.current);
        highlightTimeoutRef.current = window.setTimeout(() => {
            setHighlightedMessageId((current) => current === messageId ? null : current);
            highlightTimeoutRef.current = null;
        }, 1_600);
    }, []);

    const updateConversationAttachments = useCallback((
        conversationKey: string,
        update: (current: ChatComposerAttachment[]) => ChatComposerAttachment[],
    ) => {
        const nextAttachments = update(attachmentDraftsRef.current[conversationKey] || []);
        const nextDrafts = { ...attachmentDraftsRef.current };
        if (nextAttachments.length > 0) nextDrafts[conversationKey] = nextAttachments;
        else delete nextDrafts[conversationKey];
        attachmentDraftsRef.current = nextDrafts;
        setAttachmentDrafts(nextDrafts);
    }, []);

    const setConversationAttachmentError = useCallback((conversationKey: string, message: string | null) => {
        setAttachmentErrors((current) => {
            const next = { ...current };
            if (message) next[conversationKey] = message;
            else delete next[conversationKey];
            return next;
        });
    }, []);

    const updatePendingAttachment = useCallback((
        conversationKey: string,
        id: string,
        update: Partial<ChatComposerAttachment>,
    ) => {
        updateConversationAttachments(conversationKey, (current) => current.map((attachment) => (
            attachment.id === id ? { ...attachment, ...update } : attachment
        )));
    }, [updateConversationAttachments]);

    const uploadPendingAttachments = useCallback(async (pendingUploads: PendingChatUpload[]) => {
        for (let index = 0; index < pendingUploads.length; index += 1) {
            const pending = pendingUploads[index];
            const exists = attachmentDraftsRef.current[pending.conversationKey]
                ?.some((attachment) => attachment.id === pending.id);
            if (!exists) continue;

            updatePendingAttachment(pending.conversationKey, pending.id, {
                uploadState: 'uploading',
                uploadProgress: 0,
            });
            try {
                const media = await uploadEncryptedMediaFile(pending.file, (progress) => {
                    updatePendingAttachment(pending.conversationKey, pending.id, { uploadProgress: progress });
                });
                updatePendingAttachment(pending.conversationKey, pending.id, {
                    url: media.url,
                    filename: media.filename,
                    mimeType: media.mimeType,
                    size: media.size,
                    encryption: media.encryption,
                    file: undefined,
                    uploadState: 'ready',
                    uploadProgress: 1,
                });
            } catch (error) {
                console.error('[Chat] Attachment upload failed:', error);
                updatePendingAttachment(pending.conversationKey, pending.id, {
                    uploadState: 'failed',
                    uploadProgress: 0,
                });

                if (error instanceof MediaUploadError && error.code === 'STORAGE_NOT_CONFIGURED') {
                    const remaining = pendingUploads.slice(index).filter((waiting) => (
                        attachmentDraftsRef.current[waiting.conversationKey]
                            ?.some((attachment) => attachment.id === waiting.id)
                    ));
                    for (const waiting of remaining) {
                        updatePendingAttachment(waiting.conversationKey, waiting.id, {
                            uploadState: 'failed',
                            uploadProgress: 0,
                        });
                    }
                    setPendingStorageUploads(remaining);
                    setShowStorageConfiguration(true);
                    return;
                }

                setConversationAttachmentError(
                    pending.conversationKey,
                    error instanceof MediaUploadError
                        ? error.message
                        : 'An attachment could not be uploaded. Remove it or try again.',
                );
            }
        }
    }, [setConversationAttachmentError, updatePendingAttachment]);

    const uploadMediaFiles = useCallback(async (conversationKey: string, files: File[]) => {
        const remainingSlots = Math.max(
            0,
            CHAT_ATTACHMENT_LIMIT - (attachmentDraftsRef.current[conversationKey]?.length || 0),
        );
        if (remainingSlots === 0) {
            setConversationAttachmentError(conversationKey, `You can attach up to ${CHAT_ATTACHMENT_LIMIT} files.`);
            return;
        }

        setConversationAttachmentError(conversationKey, null);
        setStorageNotices((current) => {
            const next = { ...current };
            delete next[conversationKey];
            return next;
        });

        const validFiles: File[] = [];
        let validationError: string | null = null;
        for (const file of files) {
            if (validFiles.length >= remainingSlots) {
                validationError = `Only ${CHAT_ATTACHMENT_LIMIT} attachments can be added to a message.`;
                break;
            }
            const kind = getMediaKind(file.type);
            if (kind === 'unsupported') {
                validationError = `${file.name} is not a supported image, video, or audio file.`;
                continue;
            }
            if (file.size <= 0) {
                validationError = `${file.name} must be larger than 0 bytes.`;
                continue;
            }
            validFiles.push(file);
        }
        if (validationError) setConversationAttachmentError(conversationKey, validationError);
        if (validFiles.length === 0) return;

        const pendingUploads = validFiles.map((file): PendingChatUpload => ({
            conversationKey,
            id: `chat-${crypto.randomUUID()}`,
            file,
        }));
        const optimistic = pendingUploads.map(({ id, file }): ChatComposerAttachment => {
            const previewUrl = URL.createObjectURL(file);
            return {
                id,
                url: previewUrl,
                previewUrl,
                filename: file.name,
                mimeType: file.type as ChatAttachment['mimeType'],
                size: file.size,
                file,
                uploadState: 'uploading',
                uploadProgress: 0,
            };
        });

        updateConversationAttachments(conversationKey, (current) => (
            [...current, ...optimistic].slice(0, CHAT_ATTACHMENT_LIMIT)
        ));
        preparedSendsRef.current.delete(accountConversationKey(renderedAccountDidRef.current, conversationKey));
        await uploadPendingAttachments(pendingUploads);
    }, [setConversationAttachmentError, updateConversationAttachments, uploadPendingAttachments]);

    const handleMediaSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files || []);
        event.target.value = '';
        const conversationKey = selectedConversationKeyRef.current;
        if (!conversationKey || files.length === 0) return;
        await uploadMediaFiles(conversationKey, files);
    };

    const handleAddMedia = async () => {
        if (storageCheckInFlightRef.current) return;
        const conversationKey = selectedConversationKeyRef.current;
        if (!conversationKey) return;
        storageCheckInFlightRef.current = true;
        setConversationAttachmentError(conversationKey, null);
        try {
            if (!await getStorageProvider()) {
                setShowStorageConfiguration(true);
                return;
            }
            mediaInputRef.current?.click();
        } catch (error) {
            setConversationAttachmentError(
                conversationKey,
                error instanceof Error ? error.message : 'Media storage could not be checked.',
            );
        } finally {
            storageCheckInFlightRef.current = false;
        }
    };

    const handleRemoveAttachment = (conversationKey: string, id: string) => {
        const attachment = attachmentDraftsRef.current[conversationKey]
            ?.find((candidate) => candidate.id === id);
        if (attachment) URL.revokeObjectURL(attachment.previewUrl);
        updateConversationAttachments(conversationKey, (current) => (
            current.filter((candidate) => candidate.id !== id)
        ));
        preparedSendsRef.current.delete(accountConversationKey(renderedAccountDidRef.current, conversationKey));
        setConversationAttachmentError(conversationKey, null);
        setSendError(null);
    };

    const handleRetryAttachment = async (conversationKey: string, attachment: ChatComposerAttachment) => {
        if (!attachment.file || attachment.uploadState === 'uploading') return;
        setConversationAttachmentError(conversationKey, null);
        await uploadPendingAttachments([{ conversationKey, id: attachment.id, file: attachment.file }]);
    };

    const selectConversation = useCallback((conversation: Conversation | null) => {
        messagesRequestRef.current += 1;
        peerResolutionRef.current += 1;
        participantPresentationRefreshRef.current += 1;
        sendRequestRef.current += 1;
        const conversationKey = conversation
            ? encryptionConversationKey(conversation)
            : null;
        selectedConversationRef.current = conversation;
        selectedConversationKeyRef.current = conversationKey;
        initialScrollConversationKeyRef.current = conversationKey;
        setMessages([]);
        messageElementsRef.current.clear();
        setHighlightedMessageId(null);
        if (highlightTimeoutRef.current !== null) {
            window.clearTimeout(highlightTimeoutRef.current);
            highlightTimeoutRef.current = null;
        }
        setMessagesError(null);
        setSendError(null);
        setSending(conversation
            ? activeSendKeysRef.current.has(accountConversationKey(
                renderedAccountDidRef.current,
                encryptionConversationKey(conversation),
            ))
            : false);
        setIsAtBottom(true);
        setSelectedConversation(conversation);
    }, []);

    const applyConversationList = useCallback((nextConversations: Conversation[]) => {
        setConversations(nextConversations);
        const current = selectedConversationRef.current;
        if (!current || current.id === 'new') return;
        const refreshed = nextConversations.find((conversation) => conversation.id === current.id);
        if (!refreshed || refreshed.nodeBlocked === current.nodeBlocked) return;
        selectedConversationRef.current = refreshed;
        selectedConversationKeyRef.current = encryptionConversationKey(refreshed);
        setSelectedConversation(refreshed);
    }, []);

    // ============================================
    // HELPER FUNCTIONS (Defined before useEffects)
    // ============================================

    // Check if user is scrolled to bottom
    const checkIfAtBottom = () => {
        if (!messagesContainerRef.current) return true;
        const { scrollTop, scrollHeight, clientHeight } = messagesContainerRef.current;
        const threshold = 100; // pixels from bottom
        return scrollHeight - scrollTop - clientHeight < threshold;
    };

    // Handle scroll to track if user is at bottom
    const handleScroll = () => {
        setIsAtBottom(checkIfAtBottom());
    };

    const loadConversations = useCallback(async (isInitialLoad = true) => {
        const requestId = ++conversationsRequestRef.current;
        const requestAccountDid = renderedAccountDidRef.current;
        const e2eeMaterial = e2eeMaterialRef.current;
        conversationsAbortRef.current?.abort();
        const controller = new AbortController();
        conversationsAbortRef.current = controller;
        const timeout = window.setTimeout(() => controller.abort(), CHAT_REQUEST_TIMEOUT_MS);
        try {
            if (isInitialLoad) {
                setLoading(true);
                setConversationsError(null);
            }
            const res = await fetch('/api/swarm/chat/conversations', { signal: controller.signal });
            if (!res.ok) throw new Error('Conversations could not be loaded');
            const data = await res.json();
            let nextConversations = ((Array.isArray(data.conversations) ? data.conversations : []) as Conversation[])
                .map((conversation) => normalizeConversation(conversation, domain))
                .filter((conversation): conversation is Conversation => conversation !== null);
            nextConversations.forEach((conversation) => {
                if (conversation.participant2.profilePresentationVerified !== true) return;
                publishVerifiedPresentation({
                    ...conversation.participant2,
                    profilePresentationVerified: true,
                });
            });

            // Render the server's generic encrypted previews as soon as the list
            // arrives; local preview decryption can finish without holding the
            // whole screen on a spinner.
            if (isInitialLoad
                && requestId === conversationsRequestRef.current
                && renderedAccountDidRef.current === requestAccountDid) {
                applyConversationList(nextConversations);
                setConversationsError(null);
                setLoading(false);
            }

            if (requestAccountDid && e2eeMaterial?.accountDid === requestAccountDid) {
                nextConversations = await Promise.all(nextConversations.map(async (conversation) => {
                    if (!conversation.lastMessage) return conversation;
                    try {
                        const { content, attachments } = await decryptStoredChatMessage(
                            conversation.lastMessage,
                            requestAccountDid,
                            e2eeMaterial.material,
                        );
                        const postLinks = findChatPostLinks(content, domain);
                        const previewText = removeChatPostLinks(content, postLinks);
                        return {
                            ...conversation,
                            lastMessagePreview: postLinks.length > 0 && !previewText
                                ? uniqueChatPostLinks(postLinks).length > 1 ? 'Shared posts' : 'Shared a post'
                                : getChatMessagePreview({ text: previewText, attachments }),
                        };
                    } catch {
                        return { ...conversation, lastMessagePreview: 'Encrypted message' };
                    }
                }));
            }

            if (requestId === conversationsRequestRef.current
                && renderedAccountDidRef.current === requestAccountDid) {
                applyConversationList(nextConversations);
                setConversationsError(null);
            }
        } catch (e) {
            const isCurrentRequest = requestId === conversationsRequestRef.current
                && renderedAccountDidRef.current === requestAccountDid;
            if (isCurrentRequest) {
                console.error("Failed to load conversations", e);
                setConversationsError(controller.signal.aborted
                    ? 'The node took too long to load conversations. Try again.'
                    : e instanceof TypeError
                        ? 'The connection to the node was interrupted. Try again.'
                        : e instanceof Error ? e.message : 'Conversations could not be loaded');
            }
        } finally {
            window.clearTimeout(timeout);
            if (conversationsAbortRef.current === controller) {
                conversationsAbortRef.current = null;
            }
            if (requestId === conversationsRequestRef.current
                && renderedAccountDidRef.current === requestAccountDid) {
                setLoading(false);
            }
        }
    }, [applyConversationList, domain, publishVerifiedPresentation]);

    const markAsRead = useCallback(async (conversationId: string) => {
        const requestAccountDid = renderedAccountDidRef.current;
        try {
            const res = await fetch('/api/swarm/chat/messages', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ conversationId })
            });
            if (!res.ok || renderedAccountDidRef.current !== requestAccountDid) return;
            setConversations(prev => prev.map(c => c.id === conversationId ? { ...c, unreadCount: 0 } : c));
            window.dispatchEvent(new Event('synapsis:chat-updated'));
        } catch { }
    }, []);

    const loadMessages = useCallback(async (conversationId: string) => {
        const requestId = ++messagesRequestRef.current;
        const requestAccountDid = user?.did ?? null;
        if (!user?.did || e2eeIdentity.state.status !== 'ready') {
            if (requestId === messagesRequestRef.current) setLoadingMessages(false);
            return;
        }

        const material = e2eeIdentity.state.material;
        try {
            setMessagesError(null);
            const res = await fetch(`/api/swarm/chat/messages?conversationId=${conversationId}`);
            if (!res.ok) throw new Error('Messages could not be loaded');
            const data = await res.json();

            const storedMessages = (Array.isArray(data.messages) ? data.messages : []) as ChatMessagePayload[];
            storedMessages.forEach((message) => {
                if (message.senderProfilePresentationVerified !== true) return;
                publishVerifiedPresentation({
                    handle: message.senderHandle,
                    displayName: message.senderDisplayName,
                    avatarUrl: message.senderAvatarUrl,
                    did: message.senderDid,
                    nodeDomain: message.senderNodeDomain,
                    isNsfw: message.senderIsNsfw,
                    nodeIsNsfw: message.senderNodeIsNsfw,
                    profilePresentationVerified: true,
                    profileVersion: message.senderProfileVersion ?? null,
                });
            });
            const decryptedMessages = await Promise.all(storedMessages.map(async (msg): Promise<Message> => {
                const senderAddress = resolveAccountAddress(
                    msg.senderHandle,
                    msg.senderNodeDomain || domain,
                );
                const normalizedMessage = senderAddress
                    ? { ...msg, senderHandle: senderAddress.canonical, senderNodeDomain: senderAddress.homeDomain }
                    : msg;
                if (msg.protocolVersion !== 0 && msg.protocolVersion !== 1) {
                    return {
                        ...normalizedMessage,
                        content: 'Encrypted message unavailable',
                        attachments: [],
                        replyTo: null,
                        legacy: false,
                        decryptionError: true,
                    };
                }

                try {
                    const decrypted = await decryptStoredChatMessage(msg, user.did!, material);
                    const replyAddress = decrypted.replyTo
                        ? resolveAccountAddress(decrypted.replyTo.senderHandle, domain)
                        : null;
                    return {
                        ...normalizedMessage,
                        content: decrypted.content,
                        attachments: decrypted.attachments,
                        replyTo: decrypted.replyTo
                            ? {
                                ...decrypted.replyTo,
                                senderHandle: replyAddress?.canonical || decrypted.replyTo.senderHandle,
                            }
                            : null,
                        legacy: decrypted.legacy,
                        decryptionError: false,
                    };
                } catch (error) {
                    console.error(`[E2EE Chat] Message ${msg.id} could not be decrypted:`, error);
                    return {
                        ...normalizedMessage,
                        content: 'Encrypted message unavailable',
                        attachments: [],
                        replyTo: null,
                        legacy: false,
                        decryptionError: true,
                    };
                }
            }));

            if (requestId !== messagesRequestRef.current
                || renderedAccountDidRef.current !== requestAccountDid
                || selectedConversationRef.current?.id !== conversationId) return;

            // Only update if different
            setMessages(prev => {
                const unchanged = prev.length === decryptedMessages.length
                    && prev.every((message, index) => {
                        const next = decryptedMessages[index];
                        return message.id === next.id
                            && message.content === next.content
                            && JSON.stringify(message.attachments) === JSON.stringify(next.attachments)
                            && JSON.stringify(message.replyTo) === JSON.stringify(next.replyTo)
                            && message.decryptionError === next.decryptionError
                            && message.senderNodeBlocked === next.senderNodeBlocked
                            && message.senderDisplayName === next.senderDisplayName
                            && message.senderAvatarUrl === next.senderAvatarUrl
                            && message.readAt === next.readAt
                            && message.deliveredAt === next.deliveredAt;
                    });
                return unchanged ? prev : decryptedMessages;
            });

            // Mark as read
            void markAsRead(conversationId);
        } catch (e) {
            console.error("Failed to load messages", e);
            if (requestId === messagesRequestRef.current
                && renderedAccountDidRef.current === requestAccountDid
                && selectedConversationRef.current?.id === conversationId) {
                setMessagesError(e instanceof Error ? e.message : 'Messages could not be loaded');
            }
        } finally {
            if (requestId === messagesRequestRef.current
                && renderedAccountDidRef.current === requestAccountDid
                && selectedConversationRef.current?.id === conversationId) {
                setLoadingMessages(false);
            }
        }
    }, [domain, user?.did, e2eeIdentity.state, markAsRead, publishVerifiedPresentation]);

    const refreshConversationParticipant = useCallback(async (conversation: Conversation) => {
        const participantAddress = resolveAccountAddress(
            conversation.participant2.handle,
            conversation.participant2.nodeDomain || domain,
        );
        if (!participantAddress
            || participantAddress.homeDomain === domain
            || conversation.nodeBlocked) return;

        const requestId = ++participantPresentationRefreshRef.current;
        const requestAccountDid = renderedAccountDidRef.current;
        try {
            const response = await fetch(`/api/users/${encodeURIComponent(participantAddress.canonical)}`, {
                cache: 'no-store',
            });
            const body = await response.json().catch(() => null);
            const profile = body?.user;
            const refreshedAddress = profile
                ? resolveAccountAddress(profile.handle, profile.nodeDomain || participantAddress.homeDomain)
                : null;
            if (!response.ok
                || !profile
                || profile.profilePresentationVerified !== true
                || !refreshedAddress
                || refreshedAddress.canonical !== participantAddress.canonical
                || requestId !== participantPresentationRefreshRef.current
                || renderedAccountDidRef.current !== requestAccountDid) return;

            publishVerifiedPresentation(profile);

            const mergePresentation = (current: Conversation): Conversation => ({
                ...current,
                participant2: {
                    ...current.participant2,
                    displayName: profile.displayName || refreshedAddress.username,
                    avatarUrl: profile.avatarUrl ?? null,
                    did: profile.did || current.participant2.did,
                    nodeDomain: refreshedAddress.homeDomain,
                    isNsfw: profile.isNsfw,
                    nodeIsNsfw: profile.nodeIsNsfw,
                    stuffboxBadge: profile.stuffboxBadge ?? null,
                },
            });
            setConversations((current) => current.map((candidate) => (
                candidate.id === conversation.id ? mergePresentation(candidate) : candidate
            )));
            const selected = selectedConversationRef.current;
            if (!selected || selected.id !== conversation.id) return;
            const refreshed = mergePresentation(selected);
            const unchanged = refreshed.participant2.displayName === selected.participant2.displayName
                && refreshed.participant2.avatarUrl === selected.participant2.avatarUrl
                && refreshed.participant2.did === selected.participant2.did
                && refreshed.participant2.isNsfw === selected.participant2.isNsfw
                && refreshed.participant2.nodeIsNsfw === selected.participant2.nodeIsNsfw
                && refreshed.participant2.stuffboxBadge?.attestation
                    === selected.participant2.stuffboxBadge?.attestation;
            if (unchanged) return;
            selectedConversationRef.current = refreshed;
            selectedConversationKeyRef.current = encryptionConversationKey(refreshed);
            setSelectedConversation(refreshed);
        } catch (error) {
            console.warn(`[Chat] Could not refresh signed profile for ${participantAddress.canonical}`, error);
        }
    }, [domain, publishVerifiedPresentation]);

    const resolveConversationEncryption = useCallback(async (conversation: Conversation) => {
        const requestId = ++peerResolutionRef.current;
        const conversationKey = encryptionConversationKey(conversation);
        const requestAccountDid = user?.did ?? null;
        setConversationEncryption({ status: 'resolving', conversationKey });

        try {
            if (!user?.did || !user.handle || e2eeIdentity.state.status !== 'ready') {
                throw new E2EEClientError('Your encrypted message key is not ready', 'E2EE_IDENTITY_NOT_READY');
            }

            let recipientDid = conversation.participant2.did;
            if (!recipientDid) {
                const response = await fetch(`/api/users/${encodeURIComponent(conversation.participant2.handle)}`, {
                    cache: 'no-store',
                });
                const body = await response.json().catch(() => null);
                recipientDid = body?.user?.did;
                if (!response.ok || !recipientDid) {
                    throw new E2EEClientError('Recipient identity could not be loaded', 'E2EE_RECIPIENT_NOT_FOUND');
                }
            }

            const [sender, recipient] = await Promise.all([
                resolveE2EEPublicBundle(user.did, user.handle),
                resolveE2EEPublicBundle(recipientDid, conversation.participant2.handle),
            ]);

            if (sender.bundle.keyId !== e2eeIdentity.state.material.keyId
                || sender.bundle.publicKey !== e2eeIdentity.state.material.publicKey) {
                throw new E2EEClientError(
                    'Your local encryption key does not match your signed public key',
                    'E2EE_IDENTITY_KEY_MISMATCH',
                );
            }

            if (requestId !== peerResolutionRef.current
                || renderedAccountDidRef.current !== requestAccountDid
                || selectedConversationKeyRef.current !== conversationKey) return;
            setConversationEncryption({
                status: 'ready',
                conversationKey,
                recipientDid,
                senderBundle: sender.bundle,
                recipientBundle: recipient.bundle,
            });
        } catch (error) {
            if (requestId !== peerResolutionRef.current
                || renderedAccountDidRef.current !== requestAccountDid
                || selectedConversationKeyRef.current !== conversationKey) return;
            const clientError = error instanceof E2EEClientError ? error : null;
            setConversationEncryption({
                status: 'error',
                conversationKey,
                code: clientError?.code || 'E2EE_KEY_LOOKUP_FAILED',
                message: error instanceof Error ? error.message : 'Encryption keys could not be verified',
            });
        }
    }, [user?.did, user?.handle, e2eeIdentity.state]);

    const handleSendMessage = async (e: React.FormEvent) => {
        e.preventDefault();
        const conversation = selectedConversationRef.current;
        const conversationKey = selectedConversationKeyRef.current;
        const draftToSend = conversationKey ? drafts[conversationKey] || '' : '';
        const composerAttachments = conversationKey
            ? attachmentDraftsRef.current[conversationKey] || []
            : [];
        const replyToSend = conversationKey ? replyDrafts[conversationKey] || null : null;
        if ((!draftToSend.trim() && composerAttachments.length === 0) || !conversation || !conversationKey) return;
        if (conversation.nodeBlocked) {
            setSendError('This node is blocked. Your draft has not been sent.');
            return;
        }
        if (composerAttachments.some((attachment) => attachment.uploadState !== 'ready')) {
            setSendError('Wait for every attachment to finish uploading, or remove the failed attachment.');
            return;
        }
        const cacheKey = accountConversationKey(renderedAccountDidRef.current, conversationKey);
        if (activeSendKeysRef.current.has(cacheKey)) {
            setSendError('This encrypted message is still being confirmed.');
            return;
        }
        if (conversationEncryption.status !== 'ready'
            || conversationEncryption.conversationKey !== conversationKey) {
            setSendError('Encryption keys are still being verified. Your draft has not been sent.');
            return;
        }
        if (!user?.did || e2eeIdentity.state.status !== 'ready') {
            setSendError('Encrypted messages are locked. Your draft has not been sent.');
            return;
        }

        const accountDid = user.did;
        const requestId = ++sendRequestRef.current;
        const attachmentsToSend: ChatAttachment[] = composerAttachments.map((attachment) => ({
            url: attachment.url,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            size: attachment.size,
            ...('encryption' in attachment ? { encryption: attachment.encryption } : {}),
        }));
        let plaintext: string;
        try {
            plaintext = encodeChatMessageContent({
                text: draftToSend,
                attachments: attachmentsToSend,
                replyTo: replyToSend,
            });
        } catch (error) {
            setSendError(error instanceof Error ? error.message : 'This encrypted message cannot be sent.');
            return;
        }
        const sentAttachmentIds = composerAttachments.map((attachment) => attachment.id);
        activeSendKeysRef.current.add(cacheKey);
        setSending(true);
        setSendError(null);
        try {
            const priorPrepared = preparedSendsRef.current.get(cacheKey);
            let envelope: E2EEMessageEnvelope;
            if (priorPrepared
                && priorPrepared.accountDid === accountDid
                && priorPrepared.plaintext === plaintext
                && priorPrepared.senderKeyId === conversationEncryption.senderBundle.keyId
                && priorPrepared.recipientKeyId === conversationEncryption.recipientBundle.keyId) {
                envelope = priorPrepared.envelope;
            } else {
                envelope = await encryptE2EEMessage({
                    plaintext,
                    senderDid: accountDid,
                    senderHandle: user.handle,
                    senderBundle: conversationEncryption.senderBundle,
                    recipientDid: conversationEncryption.recipientDid,
                    recipientHandle: conversation.participant2.handle,
                    recipientBundle: conversationEncryption.recipientBundle,
                });
                preparedSendsRef.current.set(cacheKey, {
                    accountDid,
                    conversationKey,
                    plaintext,
                    senderKeyId: conversationEncryption.senderBundle.keyId,
                    recipientKeyId: conversationEncryption.recipientBundle.keyId,
                    envelope,
                });
            }
            let response: Response;
            try {
                response = await signedAPI.sendChat(
                    envelope,
                    accountDid,
                    user.handle
                );
            } catch (error) {
                throw new E2EEClientError(
                    error instanceof Error ? error.message : 'Delivery could not be confirmed',
                    'E2EE_SEND_AMBIGUOUS',
                );
            }
            if (!response.ok) {
                const body = await response.json().catch(() => null);
                if (response.status < 500) preparedSendsRef.current.delete(cacheKey);
                throw new E2EEClientError(
                    body?.error || 'Encrypted message could not be sent',
                    body?.code || (response.status >= 500 ? 'E2EE_SEND_AMBIGUOUS' : 'E2EE_SEND_FAILED'),
                    body || undefined,
                );
            }

            preparedSendsRef.current.delete(cacheKey);
            setDrafts((current) => {
                if (current[conversationKey] !== draftToSend) return current;
                const next = { ...current };
                delete next[conversationKey];
                return next;
            });
            setReplyDrafts((current) => {
                if (!replyToSend || current[conversationKey]?.messageId !== replyToSend.messageId) return current;
                const next = { ...current };
                delete next[conversationKey];
                return next;
            });
            const currentAttachments = attachmentDraftsRef.current[conversationKey] || [];
            const attachmentsUnchanged = currentAttachments.length === sentAttachmentIds.length
                && currentAttachments.every((attachment, index) => attachment.id === sentAttachmentIds[index]);
            if (attachmentsUnchanged) {
                for (const attachment of currentAttachments) URL.revokeObjectURL(attachment.previewUrl);
                updateConversationAttachments(conversationKey, () => []);
                setConversationAttachmentError(conversationKey, null);
            }

            if (requestId !== sendRequestRef.current
                || renderedAccountDidRef.current !== accountDid
                || selectedConversationKeyRef.current !== conversationKey) {
                void loadConversations(false);
                return;
            }

            // Refresh failures after a successful send must not be reported as send
            // failures or restore a draft that the server already accepted.
            try {
                if (conversation.id === 'new') {
                    const res = await fetch('/api/swarm/chat/conversations');
                    if (!res.ok) throw new Error('Conversation list could not be refreshed');
                    const data = await res.json();
                    const updatedConversations = ((data.conversations || []) as Conversation[])
                        .map((item) => normalizeConversation(item, domain))
                        .filter((item): item is Conversation => item !== null);
                    if (requestId !== sendRequestRef.current
                        || renderedAccountDidRef.current !== accountDid
                        || selectedConversationKeyRef.current !== conversationKey) return;
                    setConversations(updatedConversations);

                    const realConv = updatedConversations.find((c: Conversation) =>
                        sameAccountHandle(c.participant2.handle, conversation.participant2.handle)
                    );

                    if (realConv) selectConversation(realConv);
                } else {
                    await loadMessages(conversation.id);
                    void loadConversations(false);
                }
            } catch (refreshError) {
                console.error('[Send] Message sent, but Chat could not refresh:', refreshError);
                void loadConversations(false);
            }
        } catch (err) {
            console.error('[Send] Error:', err);
            if (requestId !== sendRequestRef.current
                || renderedAccountDidRef.current !== accountDid
                || selectedConversationKeyRef.current !== conversationKey) return;
            if (err instanceof E2EEClientError) {
                if (err.code === 'E2EE_SENDER_KEY_STALE') {
                    preparedSendsRef.current.delete(cacheKey);
                    void e2eeIdentity.retry();
                } else if (err.code === 'E2EE_RECIPIENT_KEY_STALE' || err.code === 'E2EE_NOT_CONFIGURED') {
                    preparedSendsRef.current.delete(cacheKey);
                    void resolveConversationEncryption(conversation);
                }
            }
            setSendError(err instanceof E2EEClientError && err.code === 'E2EE_SEND_AMBIGUOUS'
                ? 'Delivery could not be confirmed. Retry will safely reuse the same encrypted message.'
                : err instanceof Error
                    ? `${err.message} Your draft has not been sent.`
                    : 'Encrypted message could not be sent. Your draft has not been sent.');
        } finally {
            activeSendKeysRef.current.delete(cacheKey);
            if (renderedAccountDidRef.current === accountDid
                && selectedConversationKeyRef.current === conversationKey) {
                setSending(activeSendKeysRef.current.has(cacheKey));
            }
        }
    };

    const handleDeleteConversation = async (deleteFor: 'self' | 'both') => {
        if (!conversationToDelete) return;
        setIsDeleting(true);
        setDeleteError(null);
        try {
            const res = await fetch(`/api/swarm/chat/conversations/${conversationToDelete.id}?deleteFor=${deleteFor}`, {
                method: 'DELETE',
            });

            if (!res.ok) {
                const body = await res.json().catch(() => null);
                throw new Error(body?.error || 'Conversation could not be deleted');
            }

            setConversations(prev => prev.filter(c => c.id !== conversationToDelete.id));
            const deletedConversationKey = encryptionConversationKey(conversationToDelete);
            for (const attachment of attachmentDraftsRef.current[deletedConversationKey] || []) {
                URL.revokeObjectURL(attachment.previewUrl);
            }
            updateConversationAttachments(deletedConversationKey, () => []);
            setDrafts((current) => {
                const next = { ...current };
                delete next[deletedConversationKey];
                return next;
            });
            setReplyDrafts((current) => {
                const next = { ...current };
                delete next[deletedConversationKey];
                return next;
            });
            preparedSendsRef.current.delete(accountConversationKey(renderedAccountDidRef.current, deletedConversationKey));
            if (selectedConversation?.id === conversationToDelete.id) {
                selectConversation(null);
            }
            setShowDeleteModal(false);
            setConversationToDelete(null);
        } catch (err) {
            setDeleteError(err instanceof Error ? err.message : 'Conversation could not be deleted');
        } finally {
            setIsDeleting(false);
        }
    };

    // ============================================
    // EFFECTS (Now that functions are defined)
    // ============================================

    // Load conversations
    useEffect(() => {
        const did = user?.did ?? null;
        if (accountDidRef.current === did) return;
        accountDidRef.current = did;
        messagesRequestRef.current += 1;
        conversationsRequestRef.current += 1;
        peerResolutionRef.current += 1;
        participantPresentationRefreshRef.current += 1;
        composeRequestRef.current += 1;
        sendRequestRef.current += 1;
        preparedSendsRef.current.clear();
        activeSendKeysRef.current.clear();
        selectedConversationRef.current = null;
        selectedConversationKeyRef.current = null;
        setConversations([]);
        setSelectedConversation(null);
        setMessages([]);
        setDrafts({});
        setReplyDrafts({});
        messageElementsRef.current.clear();
        setHighlightedMessageId(null);
        if (highlightTimeoutRef.current !== null) {
            window.clearTimeout(highlightTimeoutRef.current);
            highlightTimeoutRef.current = null;
        }
        for (const attachments of Object.values(attachmentDraftsRef.current)) {
            for (const attachment of attachments) URL.revokeObjectURL(attachment.previewUrl);
        }
        attachmentDraftsRef.current = {};
        setAttachmentDrafts({});
        setAttachmentErrors({});
        setStorageNotices({});
        setPendingStorageUploads([]);
        setShowStorageConfiguration(false);
        setSendError(null);
        setConversationsError(null);
        setMessagesError(null);
        setComposeIntentError(null);
        setDismissedComposeHandle(null);
        setComposeRetryVersion(0);
        setSending(false);
        setIsAtBottom(true);
        setConversationEncryption({ status: 'idle' });
        setLoading(Boolean(did));
    }, [user?.did]);

    useEffect(() => () => {
        if (highlightTimeoutRef.current !== null) window.clearTimeout(highlightTimeoutRef.current);
        for (const attachments of Object.values(attachmentDraftsRef.current)) {
            for (const attachment of attachments) URL.revokeObjectURL(attachment.previewUrl);
        }
    }, []);

    // Load conversations
    useEffect(() => {
        if (!user?.did || !activeE2EEKeyId) return;
        void loadConversations(true);

        const pollInterval = setInterval(() => {
            void loadConversations(false);
        }, 5000);

        return () => {
            clearInterval(pollInterval);
            conversationsAbortRef.current?.abort();
            conversationsAbortRef.current = null;
            conversationsRequestRef.current += 1;
        };
    }, [user?.did, activeE2EEKeyId, loadConversations]);

    // DID/key continuity and profile presentation are separate trust states.
    // Refresh the selected remote participant even when their DID is already
    // cached, then keep long-open conversations reasonably fresh.
    useEffect(() => {
        const current = selectedConversationRef.current;
        if (!current) return;
        void refreshConversationParticipant(current);
        const interval = window.setInterval(() => {
            const current = selectedConversationRef.current;
            if (current) void refreshConversationParticipant(current);
        }, 60_000);
        return () => {
            participantPresentationRefreshRef.current += 1;
            window.clearInterval(interval);
        };
    }, [
        refreshConversationParticipant,
        selectedConversation?.id,
        selectedConversation?.nodeBlocked,
        selectedConversation?.participant2.handle,
    ]);

    // Handle Compose Intent
    useEffect(() => {
        if (!composeHandle || selectedConversation || loading || dismissedComposeHandle === composeHandle) return;

        // Check if we already have a conversation with this user.
        const existing = conversations.find(c =>
            sameAccountHandle(c.participant2.handle, composeHandle)
        );
        if (existing) {
            setComposeIntentError(null);
            selectConversation(existing);
            // Keep the share intent alive until the selected draft receives it.
            router.replace(buildChatShareContinuationHref(sharedPostUrl), { scroll: false });
            return;
        }

        // Keep a failed intent stable until the user retries. Conversation
        // polling replaces the array every few seconds and must not turn the
        // visible error back into a spinner on each successful poll.
        if (composeIntentError && sameAccountHandle(composeIntentError.handle, composeHandle)) return;

        const requestId = ++composeRequestRef.current;
        const requestAccountDid = renderedAccountDidRef.current;
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), CHAT_REQUEST_TIMEOUT_MS);
        setComposeIntentError(null);

        // Fetch user details to create a draft conversation. A transient node
        // restart must surface a retry action instead of leaving the compose
        // route behind an unconditional full-page spinner.
        const fetchUserAndInitDraft = async () => {
            try {
                const res = await fetch(`/api/users/${encodeURIComponent(composeHandle)}`, {
                    signal: controller.signal,
                });
                if (!res.ok) throw new Error(`Account lookup failed (${res.status})`);
                const data = await res.json();
                if (requestId !== composeRequestRef.current
                    || renderedAccountDidRef.current !== requestAccountDid) return;
                if (data.user) {
                    const userAddress = resolveAccountAddress(
                        data.user.handle,
                        data.user.nodeDomain || domain,
                    );
                    if (!userAddress) throw new Error('Account lookup returned an invalid address');
                    if (data.user.canReceiveDms === false) {
                        setComposeIntentError({
                            handle: composeHandle,
                            message: 'This account cannot receive direct messages.',
                        });
                        return;
                    }
                    const draftConv: Conversation = {
                        id: 'new',
                        nodeBlocked: false,
                        participant2: {
                            handle: userAddress.canonical,
                            displayName: data.user.displayName || data.user.handle,
                            avatarUrl: data.user.avatarUrl,
                            did: data.user.did,
                            nodeDomain: userAddress.homeDomain,
                            isNsfw: data.user.isNsfw,
                            nodeIsNsfw: data.user.nodeIsNsfw,
                            stuffboxBadge: data.user.stuffboxBadge,
                        },
                        lastMessageAt: new Date().toISOString(),
                        lastMessagePreview: 'New Conversation',
                        unreadCount: 0
                    };
                    selectConversation(draftConv);
                    router.replace(buildChatShareContinuationHref(sharedPostUrl), { scroll: false });
                } else {
                    setComposeIntentError({
                        handle: composeHandle,
                        message: 'That account could not be found.',
                    });
                }
            } catch (error) {
                if (requestId !== composeRequestRef.current
                    || renderedAccountDidRef.current !== requestAccountDid) return;
                console.error('Failed to load user for compose', error);
                setComposeIntentError({
                    handle: composeHandle,
                    message: controller.signal.aborted
                        ? 'The node took too long to respond. Try again.'
                        : 'The connection to the node was interrupted. Try again.',
                });
            } finally {
                window.clearTimeout(timeout);
            }
        };
        void fetchUserAndInitDraft();

        return () => {
            composeRequestRef.current += 1;
            controller.abort();
            window.clearTimeout(timeout);
        };
    }, [composeHandle, selectedConversation, conversations, loading, router, selectConversation, composeIntentError, dismissedComposeHandle, composeRetryVersion, sharedPostUrl, domain]);

    // Redirect if not logged in
    useEffect(() => {
        if (!authLoading && user === null) {
            router.push('/login');
        }
    }, [authLoading, user, router]);

    // A thread is sendable only after both participants' public bundles have
    // been resolved and verified. A failed lookup never falls back to plaintext.
    useEffect(() => {
        setSendError(null);
        if (!selectedConversation || !activeE2EEKeyId || selectedConversation.nodeBlocked) {
            peerResolutionRef.current += 1;
            setConversationEncryption({ status: 'idle' });
            return;
        }

        void resolveConversationEncryption(selectedConversation);
        return () => {
            peerResolutionRef.current += 1;
        };
    }, [selectedConversation, activeE2EEKeyId, resolveConversationEncryption]);

    // Load messages when conversation is selected
    useEffect(() => {
        messagesRequestRef.current += 1;
        setMessages([]);

        if (!selectedConversation || !activeE2EEKeyId) {
            setLoadingMessages(false);
            return;
        }

        if (selectedConversation.id === 'new') {
            setLoadingMessages(false);
            return;
        }

        setLoadingMessages(true);
        void loadMessages(selectedConversation.id);

        // Polling only retrieves ciphertext; decryption remains local.
        const pollInterval = setInterval(() => {
            void loadMessages(selectedConversation.id);
        }, 3000);

        return () => {
            clearInterval(pollInterval);
            messagesRequestRef.current += 1;
        };
    }, [selectedConversation, activeE2EEKeyId, loadMessages]);

    // A post shared from the timeline waits for the user to choose a conversation,
    // then appears in the composer so they remain in control of sending it.
    useEffect(() => {
        if (!selectedConversation
            || selectedConversation.nodeBlocked
            || !sharedPostUrl
            || appliedSharedPostRef.current === sharedPostUrl) return;

        updateSelectedDraft(sharedPostUrl);
        appliedSharedPostRef.current = sharedPostUrl;
        router.replace('/chat', { scroll: false });
    }, [selectedConversation, sharedPostUrl, router, updateSelectedDraft]);

    // Put a newly opened conversation at its newest message before the browser
    // paints it. Smooth scrolling here would visibly replay the whole history.
    useLayoutEffect(() => {
        if (!selectedConversationKey
            || initialScrollConversationKeyRef.current !== selectedConversationKey
            || loadingMessages
            || messages.length === 0) return;

        const container = messagesContainerRef.current;
        if (!container) return;
        container.scrollTop = container.scrollHeight;
        initialScrollConversationKeyRef.current = null;
        suppressSmoothScrollRef.current = true;
    }, [loadingMessages, messages.length, selectedConversationKey]);

    useLayoutEffect(() => {
        const input = messageInputRef.current;
        if (!input) return;

        resizeChatComposer(input);

        if (isAtBottom && messagesContainerRef.current) {
            messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
        }
    }, [isAtBottom, newMessage, selectedConversationKey]);

    // Auto-scroll later messages only if the user was already at the bottom.
    useEffect(() => {
        if (suppressSmoothScrollRef.current) {
            suppressSmoothScrollRef.current = false;
            return;
        }
        if (messagesEndRef.current && isAtBottom) {
            messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages, isAtBottom]);

    useEffect(() => {
        if (!showDeleteModal) return;
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || isDeleting) return;
            setDeleteError(null);
            setShowDeleteModal(false);
        };
        window.addEventListener('keydown', closeOnEscape);
        return () => window.removeEventListener('keydown', closeOnEscape);
    }, [showDeleteModal, isDeleting]);

    // ============================================
    // RENDER LOGIC
    // ============================================

    const presentedConversations = conversations.map((conversation) => {
        const presentation = getPresentation(
            conversation.participant2.handle,
            conversation.participant2.nodeDomain,
        );
        return presentation
            ? {
                ...conversation,
                participant2: {
                    ...conversation.participant2,
                    displayName: presentation.displayName,
                    avatarUrl: presentation.avatarUrl,
                    did: presentation.did || conversation.participant2.did,
                    nodeDomain: presentation.nodeDomain,
                    isNsfw: presentation.isNsfw,
                    nodeIsNsfw: presentation.nodeIsNsfw,
                    stuffboxBadge: presentation.stuffboxBadge,
                    profilePresentationVerified: true,
                    profileVersion: presentation.profileVersion,
                },
            }
            : conversation;
    });
    const filteredConversations = presentedConversations.filter((conv) =>
        conv.participant2.displayName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        conv.participant2.handle.toLowerCase().includes(searchQuery.toLowerCase())
    );
    const selectedParticipantPresentation = selectedConversation
        ? getPresentation(
            selectedConversation.participant2.handle,
            selectedConversation.participant2.nodeDomain,
        )
        : undefined;
    const selectedPresentedParticipant = selectedParticipantPresentation
        ? {
            ...selectedConversation?.participant2,
            displayName: selectedParticipantPresentation.displayName,
            avatarUrl: selectedParticipantPresentation.avatarUrl,
            nodeDomain: selectedParticipantPresentation.nodeDomain,
            isNsfw: selectedParticipantPresentation.isNsfw,
            nodeIsNsfw: selectedParticipantPresentation.nodeIsNsfw,
            stuffboxBadge: selectedParticipantPresentation.stuffboxBadge,
        }
        : selectedConversation?.participant2;
    const selectedEncryptionReady = !selectedNodeBlocked
        && conversationEncryption.status === 'ready'
        && conversationEncryption.conversationKey === selectedConversationKey;
    const selectedEncryptionError = conversationEncryption.status === 'error'
        && conversationEncryption.conversationKey === selectedConversationKey
        ? conversationEncryption
        : null;
    const selectedParticipantLabel = selectedNodeBlocked
        ? selectedHandle
        : selectedPresentedParticipant?.displayName || selectedHandle;

    if (authLoading || isIdentityRestoring) {
        return (
            <main aria-busy="true" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
                <Loader2 className="animate-spin" size={28} aria-label="Loading account" />
            </main>
        );
    }

    if (user === null) return null;

    if (!isIdentityUnlocked) {
        return (
            <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
                <div className="card" style={{ maxWidth: 420, padding: 24, textAlign: 'center' }}>
                    <h1 style={{ fontSize: 22, marginBottom: 12 }}>Session expired</h1>
                    <p style={{ color: 'var(--foreground-secondary)', marginBottom: 20 }}>
                        Please sign in again to restore your secure session.
                    </p>
                    <Link href="/login" className="btn btn-primary">
                        Sign in
                    </Link>
                </div>
            </main>
        );
    }

    if (e2eeIdentity.state.status !== 'ready') {
        return (
            <E2EEChatGate
                state={e2eeIdentity.state}
                busy={e2eeIdentity.busy}
                error={e2eeIdentity.actionError}
                identityUnlocked={isIdentityUnlocked}
                onSetup={e2eeIdentity.setup}
                onUnlock={e2eeIdentity.unlock}
                onMigrate={e2eeIdentity.migrate}
                onReset={e2eeIdentity.reset}
                onRetry={e2eeIdentity.retry}
                onCancel={() => router.push('/')}
            />
        );
    }

    // Prevent a flash of the list view while processing a compose intent, but
    // never hide a failed request behind an endless spinner.
    if (composeHandle && !selectedConversation && dismissedComposeHandle !== composeHandle) {
        const currentComposeError = composeIntentError && sameAccountHandle(composeIntentError.handle, composeHandle)
            ? composeIntentError.message
            : null;
        if (currentComposeError) {
            return (
                <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
                    <section role="alert" style={{ width: '100%', maxWidth: 420, textAlign: 'center' }}>
                        <h1 style={{ fontSize: 20, marginBottom: 10 }}>Couldn&apos;t open this conversation</h1>
                        <p style={{ color: 'var(--foreground-secondary)', lineHeight: 1.5 }}>
                            {currentComposeError}
                        </p>
                        <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 18 }}>
                            <button
                                type="button"
                                className="btn btn-primary"
                                onClick={() => {
                                    setComposeIntentError(null);
                                    setDismissedComposeHandle(null);
                                    setComposeRetryVersion((version) => version + 1);
                                }}
                            >
                                Try again
                            </button>
                            <button
                                type="button"
                                className="btn btn-ghost"
                                onClick={() => {
                                    setComposeIntentError(null);
                                    setDismissedComposeHandle(composeHandle);
                                    router.replace('/chat', { scroll: false });
                                }}
                            >
                                Back to messages
                            </button>
                        </div>
                    </section>
                </main>
            );
        }
        return (
            <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100vh', alignItems: 'center', justifyContent: 'center', color: 'var(--foreground-secondary)' }}>
                <Loader2 className="animate-spin" size={32} aria-label="Opening conversation" />
                <p>Opening conversation…</p>
            </div>
        );
    }

    // Thread View
    if (selectedConversation) {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', maxWidth: '600px', margin: '0 auto' }}>
                {/* Header */}
                <header style={{
                    position: 'sticky',
                    top: 0,
                    zIndex: 20,
                    background: 'rgba(10, 10, 10, 0.8)',
                    backdropFilter: 'blur(12px)',
                    borderBottom: '1px solid var(--border)',
                    padding: '12px 16px',
                    flexShrink: 0
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <button
                            onClick={() => selectConversation(null)}
                            aria-label="Back to conversations"
                            style={{ background: 'none', border: 'none', padding: '4px', cursor: 'pointer', color: 'var(--foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        >
                            <ArrowLeft size={20} />
                        </button>
                        <div className="avatar" style={{ width: '32px', height: '32px', fontSize: '14px' }}>
                            <AvatarImage
                                avatarUrl={selectedNodeBlocked ? null : selectedPresentedParticipant?.avatarUrl}
                                seed={selectedConversation.participant2.handle}
                                nodeDomain={selectedPresentedParticipant?.nodeDomain}
                                isNsfw={selectedPresentedParticipant?.isNsfw}
                                nodeIsNsfw={selectedPresentedParticipant?.nodeIsNsfw}
                                alt={selectedParticipantLabel}
                            />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            {selectedNodeBlocked ? (
                                <div style={{ minWidth: 0 }}>
                                    <div style={{ fontWeight: 600, fontSize: '15px' }}>{selectedParticipantLabel}</div>
                                    <div style={{ fontSize: '12px', color: 'var(--foreground-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                        {selectedHandle}
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2, fontSize: '11px', color: 'var(--foreground-secondary)' }}>
                                        <LockKeyhole size={11} aria-hidden="true" />
                                        <span>Node blocked · conversation is read-only</span>
                                    </div>
                                </div>
                            ) : (
                                <Link
                                    href={getProfilePath(
                                        selectedConversation.participant2.handle,
                                        selectedConversation.participant2.nodeDomain,
                                    )}
                                    style={{
                                        display: 'block',
                                        color: 'var(--foreground)',
                                        textDecoration: 'none',
                                        minWidth: 0,
                                    }}
                                >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: '15px' }}>
                                        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{selectedParticipantLabel}</span>
                                        <StuffboxBadge badge={selectedPresentedParticipant?.stuffboxBadge} />
                                    </div>
                                    <div style={{ fontSize: '12px', color: 'var(--foreground-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                        {selectedHandle}
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2, fontSize: '11px', color: 'var(--foreground-secondary)' }}>
                                        <LockKeyhole size={11} aria-hidden="true" />
                                        <span>{selectedEncryptionReady
                                            ? 'End-to-end encrypted messaging'
                                            : selectedEncryptionError
                                                ? 'Encryption unavailable'
                                                : 'Verifying encryption…'}</span>
                                    </div>
                                </Link>
                            )}
                        </div>
                        <button
                            aria-label="Delete conversation"
                            onClick={() => {
                                setDeleteError(null);
                                setConversationToDelete(selectedConversation);
                                setShowDeleteModal(true);
                            }}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--foreground-tertiary)', padding: '4px' }}
                        >
                            <Trash2 size={18} />
                        </button>
                    </div>
                </header>

                {selectedNodeBlocked && (
                    <div
                        role="status"
                        style={{
                            display: 'flex',
                            gap: 10,
                            padding: '12px 16px',
                            borderBottom: '1px solid var(--border)',
                            background: 'var(--background-secondary)',
                            color: 'var(--foreground-secondary)',
                            fontSize: 13,
                            lineHeight: 1.45,
                        }}
                    >
                        <LockKeyhole size={17} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
                        <span>
                            This node is blocked. Your message history remains available, but new messages and remote media are paused.
                        </span>
                    </div>
                )}

                {/* Messages */}
                <div
                    ref={messagesContainerRef}
                    onScroll={handleScroll}
                    role="log"
                    aria-live="polite"
                    aria-relevant="additions text"
                    aria-busy={loadingMessages}
                    aria-label={`Messages with ${selectedParticipantLabel}`}
                    style={{
                        padding: '16px',
                        flex: 1,
                        overflowY: 'auto',
                        paddingBottom: '16px',
                        position: 'relative'
                    }}
                >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                        {loadingMessages ? (
                            <div aria-busy="true" style={{ display: 'flex', justifyContent: 'center', padding: '40px 0', color: 'var(--foreground-secondary)' }}>
                                <Loader2 className="animate-spin" size={24} aria-label="Decrypting messages" />
                            </div>
                        ) : messagesError ? (
                            <div role="alert" style={{ textAlign: 'center', padding: '40px 16px', color: 'var(--foreground-secondary)', fontSize: 14 }}>
                                <p style={{ marginTop: 0 }}>{messagesError}</p>
                                <button type="button" className="btn btn-ghost" onClick={() => void loadMessages(selectedConversation.id)}>
                                    Try again
                                </button>
                            </div>
                        ) : messages.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: '40px 16px', color: 'var(--foreground-tertiary)', fontSize: 14 }}>
                                {selectedEncryptionReady
                                    ? 'New messages in this conversation will be end-to-end encrypted.'
                                    : 'No messages yet.'}
                            </div>
                        ) : messages.map((msg, i) => {
                            const startsEncryptedSection = msg.protocolVersion === 1
                                && i > 0
                                && messages[i - 1].legacy;
                            const detectedPostLinks = msg.decryptionError
                                ? []
                                : findChatPostLinks(msg.content, domain);
                            const sharedPostLinks = uniqueChatPostLinks(detectedPostLinks);
                            const visibleMessageContent = removeChatPostLinks(msg.content, detectedPostLinks);
                            const blockedRemoteSender = msg.senderNodeBlocked
                                || (selectedNodeBlocked && !msg.isSentByMe);
                            const emojiOnlyCount = !msg.decryptionError
                                && msg.attachments.length === 0
                                && sharedPostLinks.length === 0
                                ? getEmojiOnlyCount(visibleMessageContent)
                                : null;
                            const hasMessageBubble = msg.decryptionError
                                || ((Boolean(visibleMessageContent) || msg.attachments.length > 0)
                                    && emojiOnlyCount === null);
                            const messageReferenceId = chatMessageReferenceId(msg);
                            const canJumpToReply = Boolean(msg.replyTo
                                && loadedMessageIds.has(msg.replyTo.messageId));

                            return (
                                <Fragment key={msg.id || i}>
                                    {startsEncryptedSection && (
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--foreground-tertiary)', fontSize: 11 }}>
                                            <span style={{ height: 1, flex: 1, background: 'var(--border)' }} />
                                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                                <LockKeyhole size={11} aria-hidden="true" />
                                                End-to-end encryption starts here
                                            </span>
                                            <span style={{ height: 1, flex: 1, background: 'var(--border)' }} />
                                        </div>
                                    )}
                                    <div
                                        ref={(element) => {
                                            if (element) messageElementsRef.current.set(messageReferenceId, element);
                                            else messageElementsRef.current.delete(messageReferenceId);
                                        }}
                                        className={`chat-message-row ${msg.isSentByMe ? 'sent' : 'received'}`}
                                        style={{
                                        display: 'flex',
                                        gap: '12px',
                                        maxWidth: sharedPostLinks.length > 0 ? '92%' : '70%',
                                        marginLeft: msg.isSentByMe ? 'auto' : '0',
                                        flexDirection: msg.isSentByMe ? 'row-reverse' : 'row'
                                    }}>
                                        <div className="avatar avatar-sm" style={{ flexShrink: 0 }}>
                                            <AvatarImage
                                                avatarUrl={msg.isSentByMe
                                                    ? user.avatarUrl
                                                    : blockedRemoteSender ? null : msg.senderAvatarUrl}
                                                seed={msg.isSentByMe ? user.handle : msg.senderHandle}
                                                nodeDomain={msg.isSentByMe ? undefined : msg.senderNodeDomain}
                                                isNsfw={msg.isSentByMe ? user.isNsfw : msg.senderIsNsfw}
                                                nodeIsNsfw={msg.isSentByMe ? undefined : msg.senderNodeIsNsfw}
                                                alt={msg.isSentByMe
                                                    ? user.displayName
                                                    : blockedRemoteSender ? msg.senderHandle : msg.senderDisplayName || msg.senderHandle}
                                            />
                                        </div>

                                        <div
                                            className={`chat-message-stack ${highlightedMessageId === messageReferenceId ? 'highlighted' : ''}`}
                                            style={{ display: 'flex', flexDirection: 'column', minWidth: 0, alignItems: msg.isSentByMe ? 'flex-end' : 'flex-start' }}
                                        >
                                            {msg.replyTo && (
                                                <button
                                                    type="button"
                                                    className="chat-message-reply-quote"
                                                    onClick={() => jumpToMessage(msg.replyTo!.messageId)}
                                                    disabled={!canJumpToReply}
                                                    title={canJumpToReply ? 'Jump to original message' : 'Original message is not loaded'}
                                                    aria-label={`Reply to ${msg.replyTo.senderDisplayName || msg.replyTo.senderHandle}: ${msg.replyTo.preview}`}
                                                >
                                                    <span>{msg.replyTo.senderDisplayName || msg.replyTo.senderHandle}</span>
                                                    <span>{msg.replyTo.preview}</span>
                                                </button>
                                            )}
                                            {hasMessageBubble && (
                                                <div
                                                    role={msg.decryptionError ? 'status' : undefined}
                                                    style={{
                                                        padding: '10px 14px',
                                                        borderRadius: '16px',
                                                        background: msg.decryptionError
                                                            ? 'var(--background-secondary)'
                                                            : msg.isSentByMe ? 'var(--accent)' : 'var(--background-secondary)',
                                                        color: msg.decryptionError
                                                            ? 'var(--foreground-secondary)'
                                                            : msg.isSentByMe ? '#000' : 'var(--foreground)',
                                                        border: msg.decryptionError || !msg.isSentByMe ? '1px solid var(--border)' : 'none',
                                                        wordBreak: 'break-word',
                                                        whiteSpace: 'pre-wrap',
                                                        maxWidth: '100%'
                                                    }}
                                                >
                                                    {msg.decryptionError ? (
                                                        <div>
                                                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
                                                                <LockKeyhole size={14} aria-hidden="true" />
                                                                Encrypted message unavailable
                                                            </div>
                                                            <div style={{ marginTop: 4, fontSize: 12 }}>
                                                                This message could not be decrypted on this device.
                                                            </div>
                                                        </div>
                                                    ) : (
                                                        <>
                                                            {visibleMessageContent || null}
                                                            {blockedRemoteSender && msg.attachments.length > 0 ? (
                                                                <div role="status" style={{ marginTop: visibleMessageContent ? 8 : 0, fontSize: 12 }}>
                                                                    Remote attachments are hidden while this node is blocked.
                                                                </div>
                                                            ) : (
                                                                <ChatMessageAttachments attachments={msg.attachments} />
                                                            )}
                                                        </>
                                                    )}
                                                </div>
                                            )}
                                            {emojiOnlyCount !== null && (
                                                <div
                                                    className={`chat-emoji-message emoji-count-${emojiOnlyCount}`}
                                                    aria-label={visibleMessageContent.trim()}
                                                >
                                                    {visibleMessageContent.trim()}
                                                </div>
                                            )}
                                            {sharedPostLinks.map((postLink) => blockedRemoteSender ? (
                                                <div className="chat-post-card-fallback" role="status" key={postLink.postId}>
                                                    <div>
                                                        <div className="chat-post-card-fallback-title">Shared post hidden</div>
                                                        <div className="chat-post-card-fallback-message">
                                                            Remote content is paused while this node is blocked.
                                                        </div>
                                                    </div>
                                                </div>
                                            ) : (
                                                <ChatPostCard link={postLink} key={postLink.postId} />
                                            ))}
                                            {msg.legacy && (
                                                <div style={{ fontSize: '10px', color: 'var(--foreground-tertiary)', marginTop: 4 }}>
                                                    Sent before end-to-end encryption
                                                </div>
                                            )}
                                            <div style={{ fontSize: '11px', color: 'var(--foreground-tertiary)', marginTop: '4px' }}>
                                                {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </div>
                                        </div>
                                        {!selectedNodeBlocked && (
                                            <button
                                                type="button"
                                                className="chat-message-reply-button"
                                                onClick={() => handleReplyToMessage(msg)}
                                                aria-label={`Reply to message from ${msg.isSentByMe ? 'yourself' : msg.senderDisplayName || msg.senderHandle}`}
                                                title="Reply"
                                            >
                                                <ReplyIcon size={16} aria-hidden="true" />
                                            </button>
                                        )}
                                    </div>
                                </Fragment>
                            );
                        })}
                        <div ref={messagesEndRef} />
                    </div>
                </div>

                {/* Input */}
                <div className="compose" style={{ border: 'none', background: 'transparent', flexShrink: 0 }}>
                    <StorageConfigurationPrompt
                        open={showStorageConfiguration && !selectedNodeBlocked}
                        onConfigured={async () => {
                            setShowStorageConfiguration(false);
                            const pending = pendingStorageUploads;
                            setPendingStorageUploads([]);
                            if (pending.length > 0) {
                                await uploadPendingAttachments(pending);
                                return;
                            }
                            const conversationKey = selectedConversationKeyRef.current;
                            if (conversationKey) {
                                setStorageNotices((current) => ({
                                    ...current,
                                    [conversationKey]: 'Stuffbox connected. Choose up to four attachments.',
                                }));
                                mediaInputRef.current?.click();
                            }
                        }}
                        onCancel={() => {
                            setShowStorageConfiguration(false);
                            setPendingStorageUploads([]);
                        }}
                    />
                    {selectedNodeBlocked ? (
                        <div
                            role="status"
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                minHeight: 44,
                                padding: '0 4px',
                                color: 'var(--foreground-secondary)',
                                fontSize: 13,
                            }}
                        >
                            <LockKeyhole size={16} aria-hidden="true" />
                            This conversation is read-only while the node is blocked.
                        </div>
                    ) : selectedEncryptionReady ? (
                        <>
                            {selectedReply && (
                                <div className="chat-reply-composer" role="status">
                                    <ReplyIcon size={18} aria-hidden="true" />
                                    <div>
                                        <span>Replying to {selectedReply.senderDisplayName || selectedReply.senderHandle}</span>
                                        <span>{selectedReply.preview}</span>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => updateSelectedReply(null)}
                                        aria-label="Cancel reply"
                                        title="Cancel reply"
                                        disabled={sending}
                                    >
                                        <X size={16} aria-hidden="true" />
                                    </button>
                                </div>
                            )}
                            {selectedAttachments.length > 0 && (
                                <div className="compose-media-grid" aria-label="Message attachments">
                                    {selectedAttachments.map((attachment) => {
                                        const mediaKind = getMediaKind(attachment.mimeType);
                                        return (
                                            <div
                                                className={`compose-media-item ${mediaKind === 'audio' ? 'audio' : ''} ${attachment.uploadState}`}
                                                key={attachment.id}
                                            >
                                                {mediaKind === 'video' ? (
                                                    <video
                                                        src={attachment.previewUrl}
                                                        muted
                                                        playsInline
                                                        preload="auto"
                                                        onLoadedMetadata={(event) => primeVideoPreviewFrame(event.currentTarget)}
                                                    />
                                                ) : mediaKind === 'audio' ? (
                                                    <div className="compose-audio-preview">
                                                        <Music2 size={22} aria-hidden="true" />
                                                        <span title={attachment.filename}>{attachment.filename}</span>
                                                    </div>
                                                ) : (
                                                    <Image
                                                        unoptimized
                                                        src={attachment.previewUrl}
                                                        alt={`Preview of ${attachment.filename}`}
                                                        width={800}
                                                        height={600}
                                                    />
                                                )}
                                                {attachment.uploadState === 'uploading' && (
                                                    <div className="compose-media-upload-status" role="status" aria-label={`Uploading ${attachment.filename}`}>
                                                        <span style={{ width: `${Math.max(6, attachment.uploadProgress * 100)}%` }} />
                                                    </div>
                                                )}
                                                {attachment.uploadState === 'failed' && (
                                                    <button
                                                        type="button"
                                                        className="compose-media-retry"
                                                        onClick={() => void handleRetryAttachment(selectedConversationKey!, attachment)}
                                                        disabled={sending}
                                                    >
                                                        Retry
                                                    </button>
                                                )}
                                                <button
                                                    type="button"
                                                    className="compose-media-remove"
                                                    onClick={() => handleRemoveAttachment(selectedConversationKey!, attachment.id)}
                                                    disabled={sending}
                                                    aria-label={`Remove ${attachment.filename}`}
                                                >
                                                    <X size={12} aria-hidden="true" />
                                                </button>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                            {selectedAttachments.length > 0 && (
                                <div style={{ color: 'var(--foreground-tertiary)', fontSize: 11, margin: '8px 0 0' }}>
                                    {selectedAttachments.length} of {CHAT_ATTACHMENT_LIMIT} attachments
                                </div>
                            )}
                            <form onSubmit={handleSendMessage} style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
                                <button
                                    type="button"
                                    className="compose-media-button"
                                    title={`Attach media (${selectedAttachments.length}/${CHAT_ATTACHMENT_LIMIT})`}
                                    aria-label="Attach image, video, or audio"
                                    onClick={() => void handleAddMedia()}
                                    disabled={sending || selectedAttachments.length >= CHAT_ATTACHMENT_LIMIT}
                                >
                                    <Paperclip size={20} aria-hidden="true" />
                                </button>
                                <input
                                    ref={mediaInputRef}
                                    type="file"
                                    accept="image/*,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/mp4,audio/aac,audio/wav,audio/ogg,audio/flac"
                                    multiple
                                    onChange={handleMediaSelect}
                                    disabled={sending || selectedAttachments.length >= CHAT_ATTACHMENT_LIMIT}
                                    className="compose-media-input"
                                />
                                <textarea
                                    ref={setMessageInputRef}
                                    className="input chat-message-input"
                                    rows={1}
                                    placeholder="Type an encrypted message..."
                                    value={newMessage}
                                    onChange={e => updateSelectedDraft(e.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key !== 'Enter'
                                            || event.shiftKey
                                            || event.nativeEvent.isComposing) return;
                                        event.preventDefault();
                                        if (canSendMessage && !sending) {
                                            event.currentTarget.form?.requestSubmit();
                                        }
                                    }}
                                    aria-label={`Encrypted message to ${selectedHandle}`}
                                    aria-describedby={sendError || selectedAttachmentError ? 'encrypted-send-error' : undefined}
                                />
                                <button type="submit" disabled={!canSendMessage || sending} className="btn btn-primary" aria-label="Send encrypted message">
                                    {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                                </button>
                            </form>
                            {(sendError || selectedAttachmentError) && (
                                <p id="encrypted-send-error" role="alert" style={{ color: 'var(--destructive)', fontSize: 13, margin: '10px 0 0' }}>
                                    {sendError || selectedAttachmentError}
                                </p>
                            )}
                            {selectedStorageNotice && (
                                <p role="status" style={{ color: 'var(--success)', fontSize: 13, margin: '10px 0 0' }}>
                                    {selectedStorageNotice}
                                </p>
                            )}
                        </>
                    ) : selectedEncryptionError ? (
                        <div role="alert" style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, background: 'var(--background-secondary)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 600, fontSize: 14 }}>
                                <LockKeyhole size={15} aria-hidden="true" />
                                {selectedEncryptionError.code === 'E2EE_NOT_CONFIGURED'
                                    ? `Encrypted messaging isn't available with ${selectedHandle} yet.`
                                    : `We couldn't verify ${selectedHandle}'s encryption key.`}
                            </div>
                            <p style={{ color: 'var(--foreground-secondary)', fontSize: 13, lineHeight: 1.45, margin: '7px 0 10px' }}>
                                {selectedEncryptionError.code === 'E2EE_NOT_CONFIGURED'
                                    ? 'They need to set up encrypted messages before you can send them a DM. '
                                    : `${selectedEncryptionError.message}. `}
                                Synapsis will not send this conversation unencrypted.
                            </p>
                            <button
                                type="button"
                                className="btn btn-ghost"
                                onClick={() => void resolveConversationEncryption(selectedConversation)}
                            >
                                Check again
                            </button>
                        </div>
                    ) : (
                        <div aria-busy="true" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 44, color: 'var(--foreground-secondary)', fontSize: 13 }}>
                            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                            Verifying encryption keys…
                        </div>
                    )}
                </div>
                {/* Delete Modal */}
                {showDeleteModal && (
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="delete-conversation-title"
                        style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(0,0,0,0.5)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 50
                    }}>
                        <div style={{
                            background: 'var(--background)',
                            padding: '24px',
                            borderRadius: '16px',
                            width: '100%',
                            maxWidth: '320px',
                            boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
                        }}>
                            <h3 id="delete-conversation-title" style={{ marginTop: 0, fontSize: '18px', fontWeight: 600 }}>Delete Conversation</h3>
                            <p style={{ color: 'var(--foreground-secondary)', fontSize: '14px', marginBottom: '24px' }}>
                                This action cannot be undone.
                            </p>
                            {deleteError && (
                                <p role="alert" style={{ color: 'var(--destructive)', fontSize: 13, margin: '0 0 14px' }}>
                                    {deleteError}
                                </p>
                            )}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                <button
                                    disabled={isDeleting}
                                    onClick={() => handleDeleteConversation('self')}
                                    className="btn"
                                    style={{ justifyContent: 'center', width: '100%' }}
                                >
                                    Delete for me
                                </button>
                                {isHandleOnNode(selectedConversation.participant2.handle, domain) && (
                                    <button
                                        disabled={isDeleting}
                                        onClick={() => handleDeleteConversation('both')}
                                        className="btn btn-danger"
                                        style={{ justifyContent: 'center', width: '100%', color: 'var(--destructive)', background: 'var(--destructive-10)' }}
                                    >
                                        Delete for everyone
                                    </button>
                                )}
                                {!isHandleOnNode(selectedConversation.participant2.handle, domain) && (
                                    <p style={{ color: 'var(--foreground-tertiary)', fontSize: 12, margin: '2px 0 0', textAlign: 'center' }}>
                                        Across nodes, deleting removes only your copy.
                                    </p>
                                )}
                                <button
                                    disabled={isDeleting}
                                    onClick={() => {
                                        setDeleteError(null);
                                        setShowDeleteModal(false);
                                    }}
                                    className="btn btn-ghost"
                                    style={{ justifyContent: 'center', width: '100%' }}
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    // LIST VIEW
    return (
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', maxWidth: '600px', margin: '0 auto', background: 'var(--background)' }}>
            <div style={{ position: 'sticky', top: 0, zIndex: 20, background: 'var(--background)' }}>
                <header style={{
                    padding: '16px',
                    borderBottom: '1px solid var(--border)',
                    background: 'rgba(10, 10, 10, 0.8)',
                    backdropFilter: 'blur(12px)',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <h1 style={{ fontSize: '18px', fontWeight: 600, margin: 0 }}>Chat</h1>
                    </div>
                </header>

                <div style={{
                    padding: '16px', // Reverted from 20px to 16px as requested
                    borderBottom: '1px solid var(--border)',
                    background: 'rgba(10, 10, 10, 0.8)',
                    backdropFilter: 'blur(12px)',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--background-secondary)', borderRadius: 'var(--radius-full)', padding: '8px 16px', border: '1px solid var(--border)' }}>
                        <Search size={16} style={{ color: 'var(--foreground-tertiary)' }} aria-hidden="true" />
                        <input
                            type="text"
                            placeholder="Search..."
                            aria-label="Search conversations"
                            style={{ background: 'transparent', border: 'none', outline: 'none', flex: 1, color: 'var(--foreground)' }}
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                        />
                    </div>
                </div>
            </div>

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                {loading ? (
                    <div aria-busy="true" style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
                        <Loader2 className="animate-spin" size={32} aria-label="Loading conversations" />
                    </div>
                ) : conversationsError ? (
                    <div role="alert" style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--foreground-secondary)' }}>
                        <p>{conversationsError}</p>
                        <button type="button" className="btn btn-ghost" onClick={() => void loadConversations(true)}>
                            Try again
                        </button>
                    </div>
                ) : filteredConversations.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--foreground-tertiary)' }}>
                        <MessageCircle size={48} style={{ margin: '0 auto 16px', opacity: 0.5 }} />
                        <p>No conversations yet</p>
                    </div>
                ) : (
                    filteredConversations.map(conv => (
                        <button
                            type="button"
                            key={conv.id}
                            className="post"
                            onClick={() => selectConversation(conv)}
                            style={{ cursor: 'pointer', display: 'flex', alignItems: 'flex-start', gap: '12px', width: '100%', textAlign: 'left', color: 'inherit', border: 0 }}
                        >
                            <div className="avatar">
                                <AvatarImage
                                    avatarUrl={conv.nodeBlocked ? null : conv.participant2.avatarUrl}
                                    seed={conv.participant2.handle}
                                    nodeDomain={conv.participant2.nodeDomain}
                                    isNsfw={conv.participant2.isNsfw}
                                    nodeIsNsfw={conv.participant2.nodeIsNsfw}
                                    alt={conv.nodeBlocked
                                        ? displayAccountAddress(conv.participant2.handle)
                                        : conv.participant2.displayName || conv.participant2.handle}
                                />
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, fontWeight: 600, fontSize: '15px' }}>
                                        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                            {conv.nodeBlocked
                                                ? displayAccountAddress(conv.participant2.handle)
                                                : conv.participant2.displayName || conv.participant2.handle}
                                        </span>
                                        {!conv.nodeBlocked && <StuffboxBadge badge={conv.participant2.stuffboxBadge} />}
                                    </span>
                                    {conv.unreadCount > 0 && <span className="badge" style={{ background: 'var(--accent)', color: '#000', borderRadius: '10px', padding: '2px 8px', fontSize: '11px', fontWeight: 600 }}>{conv.unreadCount}</span>}
                                </div>
                                <div style={{ fontSize: '12px', color: 'var(--foreground-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: '2px' }}>
                                    {displayAccountAddress(conv.participant2.handle)}
                                </div>
                                <div style={{ fontSize: '13px', color: 'var(--foreground-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: '2px' }}>
                                    {conv.nodeBlocked ? 'Node blocked · History available' : conv.lastMessagePreview}
                                </div>
                            </div>
                        </button>
                    ))
                )}
            </div>
            {sharedPostUrl && !composeHandle && (
                <ChatRecipientPicker
                    currentUserHandle={user.handle}
                    onClose={() => router.replace('/chat', { scroll: false })}
                    onSelect={(recipient) => {
                        router.replace(buildChatShareHref(recipient.handle, sharedPostUrl), { scroll: false });
                    }}
                />
            )}
        </div>
    );
}
