'use client';

import { Fragment, useCallback, useState, useEffect, useRef } from 'react';
import { useAuth } from '@/lib/contexts/AuthContext';
import { signedAPI } from '@/lib/api/signed-fetch';
import { ArrowLeft, Send, Loader2, LockKeyhole, MessageCircle, Search, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { getProfilePath, useFormattedHandle } from '@/lib/utils/handle';
import { useRouter, useSearchParams } from 'next/navigation';
import { AvatarImage } from '@/components/AvatarImage';
import { E2EEChatGate } from '@/components/E2EEChatGate';
import { IdentityUnlockPrompt } from '@/components/IdentityUnlockPrompt';
import {
    decryptStoredChatMessage,
    E2EEClientError,
    resolveE2EEPublicBundle,
    type StoredChatMessage,
} from '@/lib/e2ee/client';
import { encryptE2EEMessage } from '@/lib/e2ee/client-crypto';
import type { E2EEKeyBundle, E2EEMessageEnvelope } from '@/lib/e2ee/protocol';
import { useE2EEIdentity } from '@/lib/e2ee/use-e2ee-identity';

interface Conversation {
    id: string;
    participant2: {
        handle: string;
        displayName: string;
        avatarUrl: string | null;
        did?: string; // Add DID support
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
    senderHandle: string;
    senderDisplayName?: string;
    senderAvatarUrl?: string;
    senderDid?: string;
    isSentByMe: boolean;
    deliveredAt?: string;
    readAt?: string;
    createdAt: string;
}

type Message = Omit<ChatMessagePayload, 'content'> & {
    content: string;
    legacy: boolean;
    decryptionError: boolean;
};

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

interface PreparedSend {
    accountDid: string;
    conversationKey: string;
    draft: string;
    senderKeyId: string;
    recipientKeyId: string;
    envelope: E2EEMessageEnvelope;
}

function encryptionConversationKey(conversation: Conversation): string {
    return `${conversation.id}:${conversation.participant2.did || conversation.participant2.handle}`;
}

function accountConversationKey(accountDid: string | null, conversationKey: string): string {
    return JSON.stringify([accountDid, conversationKey]);
}

export default function ChatPage() {
    const { user, loading: authLoading, isIdentityUnlocked, isRestoring: isIdentityRestoring } = useAuth();
    const router = useRouter();
    const searchParams = useSearchParams();
    const composeHandle = searchParams.get('compose');
    const sharedPostUrl = searchParams.get('share');
    const e2eeIdentity = useE2EEIdentity(user?.did, user?.handle);
    const activeE2EEKeyId = e2eeIdentity.state.status === 'ready'
        ? e2eeIdentity.state.material.keyId
        : null;

    // Chat Data State
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
    const selectedHandle = useFormattedHandle(selectedConversation?.participant2.handle || '');
    const [messages, setMessages] = useState<Message[]>([]);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(true);
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState<string | null>(null);
    const [conversationsError, setConversationsError] = useState<string | null>(null);
    const [messagesError, setMessagesError] = useState<string | null>(null);
    const [conversationEncryption, setConversationEncryption] = useState<ConversationEncryptionState>({ status: 'idle' });
    const [searchQuery, setSearchQuery] = useState('');
    const [loadingMessages, setLoadingMessages] = useState(false);

    // Legacy / V2 Hybrid State
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [conversationToDelete, setConversationToDelete] = useState<Conversation | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const [isAtBottom, setIsAtBottom] = useState(true);
    const appliedSharedPostRef = useRef<string | null>(null);
    const messagesRequestRef = useRef(0);
    const conversationsRequestRef = useRef(0);
    const peerResolutionRef = useRef(0);
    const composeRequestRef = useRef(0);
    const sendRequestRef = useRef(0);
    const accountDidRef = useRef<string | null>(null);
    const renderedAccountDidRef = useRef<string | null>(user?.did ?? null);
    const selectedConversationRef = useRef<Conversation | null>(selectedConversation);
    const selectedConversationKeyRef = useRef<string | null>(null);
    const preparedSendsRef = useRef(new Map<string, PreparedSend>());
    const activeSendKeysRef = useRef(new Set<string>());

    renderedAccountDidRef.current = user?.did ?? null;
    selectedConversationRef.current = selectedConversation;
    selectedConversationKeyRef.current = selectedConversation
        ? encryptionConversationKey(selectedConversation)
        : null;

    const selectedConversationKey = selectedConversationKeyRef.current;
    const newMessage = selectedConversationKey ? drafts[selectedConversationKey] || '' : '';

    const updateSelectedDraft = useCallback((value: string) => {
        const key = selectedConversationKeyRef.current;
        if (!key) return;
        const cacheKey = accountConversationKey(renderedAccountDidRef.current, key);
        const prepared = preparedSendsRef.current.get(cacheKey);
        if (prepared && prepared.draft !== value) preparedSendsRef.current.delete(cacheKey);
        setDrafts((current) => current[key] === value ? current : { ...current, [key]: value });
        setSendError(null);
    }, []);

    const selectConversation = useCallback((conversation: Conversation | null) => {
        messagesRequestRef.current += 1;
        peerResolutionRef.current += 1;
        sendRequestRef.current += 1;
        selectedConversationRef.current = conversation;
        selectedConversationKeyRef.current = conversation
            ? encryptionConversationKey(conversation)
            : null;
        setMessages([]);
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
        const requestAccountDid = user?.did ?? null;
        try {
            if (isInitialLoad) {
                setLoading(true);
                setConversationsError(null);
            }
            const res = await fetch('/api/swarm/chat/conversations');
            if (!res.ok) throw new Error('Conversations could not be loaded');
            const data = await res.json();
            let nextConversations = (Array.isArray(data.conversations) ? data.conversations : []) as Conversation[];

            // Render the server's generic encrypted previews as soon as the list
            // arrives; local preview decryption can finish without holding the
            // whole screen on a spinner.
            if (isInitialLoad
                && requestId === conversationsRequestRef.current
                && renderedAccountDidRef.current === requestAccountDid) {
                setConversations(nextConversations);
                setConversationsError(null);
                setLoading(false);
            }

            if (user?.did && e2eeIdentity.state.status === 'ready') {
                const material = e2eeIdentity.state.material;
                nextConversations = await Promise.all(nextConversations.map(async (conversation) => {
                    if (!conversation.lastMessage) return conversation;
                    try {
                        const { content } = await decryptStoredChatMessage(
                            conversation.lastMessage,
                            user.did!,
                            material,
                        );
                        const normalized = content.replace(/\s+/g, ' ').trim();
                        const characters = Array.from(normalized);
                        return {
                            ...conversation,
                            lastMessagePreview: characters.length > 96
                                ? `${characters.slice(0, 96).join('')}…`
                                : normalized,
                        };
                    } catch {
                        return { ...conversation, lastMessagePreview: 'Encrypted message' };
                    }
                }));
            }

            if (requestId === conversationsRequestRef.current
                && renderedAccountDidRef.current === requestAccountDid) {
                setConversations(nextConversations);
                setConversationsError(null);
            }
        } catch (e) {
            console.error("Failed to load conversations", e);
            if (requestId === conversationsRequestRef.current
                && renderedAccountDidRef.current === requestAccountDid) {
                setConversationsError(e instanceof Error ? e.message : 'Conversations could not be loaded');
            }
        } finally {
            if (requestId === conversationsRequestRef.current
                && renderedAccountDidRef.current === requestAccountDid) {
                setLoading(false);
            }
        }
    }, [user?.did, e2eeIdentity.state]);

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
            const decryptedMessages = await Promise.all(storedMessages.map(async (msg): Promise<Message> => {
                if (msg.protocolVersion !== 0 && msg.protocolVersion !== 1) {
                    return {
                        ...msg,
                        content: 'Encrypted message unavailable',
                        legacy: false,
                        decryptionError: true,
                    };
                }

                try {
                    const decrypted = await decryptStoredChatMessage(msg, user.did!, material);
                    return {
                        ...msg,
                        content: decrypted.content,
                        legacy: decrypted.legacy,
                        decryptionError: false,
                    };
                } catch (error) {
                    console.error(`[E2EE Chat] Message ${msg.id} could not be decrypted:`, error);
                    return {
                        ...msg,
                        content: 'Encrypted message unavailable',
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
                            && message.decryptionError === next.decryptionError
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
    }, [user?.did, e2eeIdentity.state, markAsRead]);

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
        if (!draftToSend.trim() || !conversation || !conversationKey) return;
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
        if (new TextEncoder().encode(draftToSend).length > 8_000) {
            setSendError('Encrypted messages can be up to 8,000 bytes. Your draft has not been sent.');
            return;
        }
        activeSendKeysRef.current.add(cacheKey);
        setSending(true);
        setSendError(null);
        try {
            const priorPrepared = preparedSendsRef.current.get(cacheKey);
            let envelope: E2EEMessageEnvelope;
            if (priorPrepared
                && priorPrepared.accountDid === accountDid
                && priorPrepared.draft === draftToSend
                && priorPrepared.senderKeyId === conversationEncryption.senderBundle.keyId
                && priorPrepared.recipientKeyId === conversationEncryption.recipientBundle.keyId) {
                envelope = priorPrepared.envelope;
            } else {
                envelope = await encryptE2EEMessage({
                    plaintext: draftToSend,
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
                    draft: draftToSend,
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
                    const updatedConversations = (data.conversations || []) as Conversation[];
                    if (requestId !== sendRequestRef.current
                        || renderedAccountDidRef.current !== accountDid
                        || selectedConversationKeyRef.current !== conversationKey) return;
                    setConversations(updatedConversations);

                    const realConv = updatedConversations.find((c: Conversation) =>
                        c.participant2.handle === conversation.participant2.handle
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
        setSendError(null);
        setConversationsError(null);
        setMessagesError(null);
        setSending(false);
        setIsAtBottom(true);
        setConversationEncryption({ status: 'idle' });
        setLoading(Boolean(did));
    }, [user?.did]);

    // Load conversations
    useEffect(() => {
        if (!user) return;
        void loadConversations(true);

        const pollInterval = setInterval(() => {
            void loadConversations(false);
        }, 5000);

        return () => {
            clearInterval(pollInterval);
            conversationsRequestRef.current += 1;
        };
    }, [user, activeE2EEKeyId, loadConversations]);

    // Handle Compose Intent
    useEffect(() => {
        if (composeHandle && !selectedConversation && conversations.length >= 0) {
            // Check if we already have a conversation with this user
            const existing = conversations.find(c =>
                c.participant2.handle.toLowerCase() === composeHandle.toLowerCase()
            );

            if (existing) {
                selectConversation(existing);
                // Clear the query param so refresh doesn't keep resetting state
                router.replace('/chat', { scroll: false });
            } else if (!loading) {
                // Fetch user details to create a draft conversation
                const fetchUserAndInitDraft = async () => {
                    const requestId = ++composeRequestRef.current;
                    const requestAccountDid = renderedAccountDidRef.current;
                    try {
                        const res = await fetch(`/api/users/${encodeURIComponent(composeHandle)}`);
                        const data = await res.json();
                        if (requestId !== composeRequestRef.current
                            || renderedAccountDidRef.current !== requestAccountDid) return;
                        if (data.user) {
                            if (data.user.isBot || data.user.canReceiveDms === false) {
                                console.error('Cannot DM this account due to privacy settings');
                                router.replace('/chat');
                                return;
                            }
                            const draftConv: Conversation = {
                                id: 'new',
                                participant2: {
                                    handle: data.user.handle,
                                    displayName: data.user.displayName || data.user.handle,
                                    avatarUrl: data.user.avatarUrl,
                                    did: data.user.did
                                },
                                lastMessageAt: new Date().toISOString(),
                                lastMessagePreview: 'New Conversation',
                                unreadCount: 0
                            };
                            selectConversation(draftConv);
                            router.replace('/chat', { scroll: false });
                        } else {
                            // User not found, clear compose param to show list
                            console.error('User not found for compose');
                            router.replace('/chat');
                        }
                    } catch (e) {
                        if (requestId !== composeRequestRef.current
                            || renderedAccountDidRef.current !== requestAccountDid) return;
                        console.error("Failed to load user for compose", e);
                        router.replace('/chat');
                    }
                };
                fetchUserAndInitDraft();
            }
        }
        return () => {
            composeRequestRef.current += 1;
        };
    }, [composeHandle, selectedConversation, conversations, loading, router, selectConversation]);

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
        if (!selectedConversation || !activeE2EEKeyId) {
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
        if (!selectedConversation || !sharedPostUrl || appliedSharedPostRef.current === sharedPostUrl) return;

        updateSelectedDraft(sharedPostUrl);
        appliedSharedPostRef.current = sharedPostUrl;
        router.replace('/chat', { scroll: false });
    }, [selectedConversation, sharedPostUrl, router, updateSelectedDraft]);

    // Auto-scroll to bottom of messages only if user was already at bottom
    useEffect(() => {
        if (messagesEndRef.current && isAtBottom) {
            messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages, isAtBottom]);

    useEffect(() => {
        setIsAtBottom(true);
        const frame = window.requestAnimationFrame(() => {
            const container = messagesContainerRef.current;
            if (container) container.scrollTop = container.scrollHeight;
        });
        return () => window.cancelAnimationFrame(frame);
    }, [selectedConversationKey]);

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

    const filteredConversations = conversations.filter((conv) =>
        conv.participant2.displayName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        conv.participant2.handle.toLowerCase().includes(searchQuery.toLowerCase())
    );
    const selectedEncryptionReady = conversationEncryption.status === 'ready'
        && conversationEncryption.conversationKey === selectedConversationKey;
    const selectedEncryptionError = conversationEncryption.status === 'error'
        && conversationEncryption.conversationKey === selectedConversationKey
        ? conversationEncryption
        : null;

    if (authLoading || isIdentityRestoring) {
        return (
            <main aria-busy="true" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
                <Loader2 className="animate-spin" size={28} aria-label="Loading account" />
            </main>
        );
    }

    if (user === null) return null;

    if (!isIdentityUnlocked) {
        return <IdentityUnlockPrompt onCancel={() => router.push('/')} />;
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
                onReset={e2eeIdentity.reset}
                onRetry={e2eeIdentity.retry}
                onCancel={() => router.push('/')}
            />
        );
    }

    // Prevent flash of list view while processing compose intent
    if (composeHandle && !selectedConversation) {
        return (
            <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>
                <Loader2 className="animate-spin" size={32} aria-label="Opening conversation" />
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
                                avatarUrl={selectedConversation.participant2.avatarUrl}
                                seed={selectedConversation.participant2.handle}
                                alt={selectedConversation.participant2.displayName || selectedConversation.participant2.handle}
                            />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <Link
                                href={getProfilePath(selectedConversation.participant2.handle)}
                                style={{
                                    display: 'block',
                                    color: 'var(--foreground)',
                                    textDecoration: 'none',
                                    minWidth: 0,
                                }}
                            >
                                <div style={{ fontWeight: 600, fontSize: '15px' }}>{selectedConversation.participant2.displayName}</div>
                                <div style={{ fontSize: '12px', color: 'var(--foreground-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {selectedHandle}
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2, fontSize: '11px', color: 'var(--foreground-secondary)' }}>
                                    <LockKeyhole size={11} aria-hidden="true" />
                                    <span>{selectedEncryptionReady
                                        ? 'End-to-end encryption ready'
                                        : selectedEncryptionError
                                            ? 'Encryption unavailable'
                                            : 'Verifying encryption…'}</span>
                                </div>
                            </Link>
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

                {/* Messages */}
                <div
                    ref={messagesContainerRef}
                    onScroll={handleScroll}
                    role="log"
                    aria-live="polite"
                    aria-relevant="additions text"
                    aria-busy={loadingMessages}
                    aria-label={`Messages with ${selectedConversation.participant2.displayName || selectedHandle}`}
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
                                    <div style={{
                                        display: 'flex',
                                        gap: '12px',
                                        maxWidth: '70%',
                                        marginLeft: msg.isSentByMe ? 'auto' : '0',
                                        flexDirection: msg.isSentByMe ? 'row-reverse' : 'row'
                                    }}>
                                        <div className="avatar avatar-sm" style={{ flexShrink: 0 }}>
                                            <AvatarImage
                                                avatarUrl={msg.isSentByMe ? user.avatarUrl : msg.senderAvatarUrl}
                                                seed={msg.isSentByMe ? user.handle : msg.senderHandle}
                                                alt={msg.isSentByMe ? user.displayName : msg.senderDisplayName || msg.senderHandle}
                                            />
                                        </div>

                                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: msg.isSentByMe ? 'flex-end' : 'flex-start' }}>
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
                                                    whiteSpace: 'pre-wrap'
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
                                                ) : msg.content}
                                            </div>
                                            {msg.legacy && (
                                                <div style={{ fontSize: '10px', color: 'var(--foreground-tertiary)', marginTop: 4 }}>
                                                    Sent before end-to-end encryption
                                                </div>
                                            )}
                                            <div style={{ fontSize: '11px', color: 'var(--foreground-tertiary)', marginTop: '4px' }}>
                                                {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </div>
                                        </div>
                                    </div>
                                </Fragment>
                            );
                        })}
                        <div ref={messagesEndRef} />
                    </div>
                </div>

                {/* Input */}
                <div className="compose" style={{ borderTop: '1px solid var(--border)', background: 'var(--background)', flexShrink: 0 }}>
                    {selectedEncryptionReady ? (
                        <>
                            <form onSubmit={handleSendMessage} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                <input
                                    type="text"
                                    className="input"
                                    style={{ flex: 1 }}
                                    placeholder="Type an encrypted message..."
                                    value={newMessage}
                                    onChange={e => updateSelectedDraft(e.target.value)}
                                    aria-label={`Encrypted message to ${selectedHandle}`}
                                    aria-describedby={sendError ? 'encrypted-send-error' : undefined}
                                />
                                <button type="submit" disabled={!newMessage.trim() || sending} className="btn btn-primary" aria-label="Send encrypted message">
                                    {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                                </button>
                            </form>
                            {sendError && (
                                <p id="encrypted-send-error" role="alert" style={{ color: 'var(--destructive)', fontSize: 13, margin: '10px 0 0' }}>
                                    {sendError}
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
                                {!selectedConversation.participant2.handle.includes('@') && (
                                    <button
                                        disabled={isDeleting}
                                        onClick={() => handleDeleteConversation('both')}
                                        className="btn btn-danger"
                                        style={{ justifyContent: 'center', width: '100%', color: 'var(--destructive)', background: 'var(--destructive-10)' }}
                                    >
                                        Delete for everyone
                                    </button>
                                )}
                                {selectedConversation.participant2.handle.includes('@') && (
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

                {sharedPostUrl && (
                    <div className="chat-share-intent">
                        Choose a conversation to share this post.
                    </div>
                )}

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
                                    avatarUrl={conv.participant2.avatarUrl}
                                    seed={conv.participant2.handle}
                                    alt={conv.participant2.displayName || conv.participant2.handle}
                                />
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                                    <span style={{ fontWeight: 600, fontSize: '15px' }}>{conv.participant2.displayName || conv.participant2.handle}</span>
                                    {conv.unreadCount > 0 && <span className="badge" style={{ background: 'var(--accent)', color: '#000', borderRadius: '10px', padding: '2px 8px', fontSize: '11px', fontWeight: 600 }}>{conv.unreadCount}</span>}
                                </div>
                                <div style={{ fontSize: '13px', color: 'var(--foreground-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: '2px' }}>
                                    {conv.lastMessagePreview}
                                </div>
                            </div>
                        </button>
                    ))
                )}
            </div>
        </div>
    );
}
