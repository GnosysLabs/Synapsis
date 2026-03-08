'use client';

import { useState, useEffect, useRef } from 'react';
import { useAuth } from '@/lib/contexts/AuthContext';
import { signedAPI } from '@/lib/api/signed-fetch';
import { ArrowLeft, Send, Loader2, MessageCircle, Search, Plus, Trash2, MoreVertical } from 'lucide-react';
import { useFormattedHandle } from '@/lib/utils/handle';
import { useRouter, useSearchParams } from 'next/navigation';

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
    unreadCount: number;
}


interface Message {
    id: string;
    senderHandle: string;
    senderDisplayName?: string;
    senderAvatarUrl?: string;
    senderDid?: string;
    content: string;
    isSentByMe: boolean;
    deliveredAt?: string;
    readAt?: string;
    createdAt: string;
}

export default function ChatPage() {
    const { user } = useAuth();
    const router = useRouter();
    const searchParams = useSearchParams();
    const composeHandle = searchParams.get('compose');

    // Chat Data State
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
    const selectedHandle = selectedConversation ? useFormattedHandle(selectedConversation.participant2.handle) : '';
    const [messages, setMessages] = useState<Message[]>([]);
    const [newMessage, setNewMessage] = useState('');
    const [loading, setLoading] = useState(true);
    const [sending, setSending] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [loadingMessages, setLoadingMessages] = useState(false);

    // Legacy / V2 Hybrid State
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [conversationToDelete, setConversationToDelete] = useState<Conversation | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const [isAtBottom, setIsAtBottom] = useState(true);

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

    // Scroll to bottom manually
    const scrollToBottom = () => {
        if (messagesEndRef.current) {
            messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    };

    const loadConversations = async (isInitialLoad = true) => {
        try {
            if (isInitialLoad) setLoading(true);
            const res = await fetch('/api/swarm/chat/conversations');
            if (res.ok) {
                const data = await res.json();
                setConversations(data.conversations || []);
            }
        } catch (e) {
            console.error("Failed to load conversations", e);
        } finally {
            if (isInitialLoad) setLoading(false);
        }
    };

    const loadMessages = async (conversationId: string) => {
        try {
            const res = await fetch(`/api/swarm/chat/messages?conversationId=${conversationId}`);
            const data = await res.json();

            const plainMessages = (data.messages || []).map((msg: any) => ({
                ...msg,
                content: msg.content || '[Empty Message]'
            }));

            // Only update if different
            setMessages(prev => {
                const prevIds = prev.map(m => m.id).join(',');
                const newIds = plainMessages.map((m: any) => m.id).join(',');
                if (prevIds === newIds && prev.length === plainMessages.length) return prev;
                return plainMessages;
            });

            // Mark as read
            markAsRead(conversationId);
        } catch (e) {
            console.error("Failed to load messages", e);
        }
    };

    const markAsRead = async (conversationId: string) => {
        try {
            const res = await fetch('/api/swarm/chat/messages', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ conversationId })
            });
            if (!res.ok) {
                return;
            }
            setConversations(prev => prev.map(c => c.id === conversationId ? { ...c, unreadCount: 0 } : c));
            window.dispatchEvent(new Event('synapsis:chat-updated'));
        } catch { }
    };

    const handleSendMessage = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newMessage.trim() || !selectedConversation) return;
        setSending(true);
        try {
            // Get recipient DID
            let did = selectedConversation.participant2.did;

            if (!did) {
                const res = await fetch(`/api/users/${encodeURIComponent(selectedConversation.participant2.handle)}`);
                const data = await res.json();
                did = data.user?.did;
                if (!did) throw new Error('User not found');
            }

            if (!user || !user.did) throw new Error('User identity not loaded or DID missing');



            // Send using Signed API
            await signedAPI.sendChat(
                did,
                selectedConversation.participant2.handle,
                newMessage,
                user.did,
                user.handle
            );

            setNewMessage('');

            // If this was a new conversation, we need to refresh the conversation list and select the real one
            if (selectedConversation.id === 'new') {
                // Refresh conversations to get the new ID
                const res = await fetch('/api/swarm/chat/conversations');
                const data = await res.json();
                const updatedConversations = data.conversations || [];
                setConversations(updatedConversations);

                // Find the real conversation
                const realConv = updatedConversations.find((c: Conversation) =>
                    c.participant2.handle === selectedConversation.participant2.handle
                );

                if (realConv) {
                    setSelectedConversation(realConv);
                    loadMessages(realConv.id);
                }
            } else {
                await loadMessages(selectedConversation.id);
                loadConversations(false);
            }
        } catch (err: any) {
            console.error('[Send] Error:', err);
            alert(`Failed: ${err.message}`);
        } finally {
            setSending(false);
        }
    };

    const handleDeleteConversation = async (deleteFor: 'self' | 'both') => {
        if (!conversationToDelete) return;
        setIsDeleting(true);
        try {
            const res = await fetch(`/api/swarm/chat/conversations/${conversationToDelete.id}?deleteFor=${deleteFor}`, {
                method: 'DELETE',
            });

            if (res.ok) {
                setConversations(prev => prev.filter(c => c.id !== conversationToDelete.id));
                if (selectedConversation?.id === conversationToDelete.id) {
                    setSelectedConversation(null);
                }
                setShowDeleteModal(false);
                setConversationToDelete(null);
            }
        } catch (err) {
            alert('Failed to delete');
        } finally {
            setIsDeleting(false);
        }
    };

    // ============================================
    // EFFECTS (Now that functions are defined)
    // ============================================

    // Load conversations
    // Load conversations
    useEffect(() => {
        if (user) {
            loadConversations(true); // Initial load with spinner

            // Poll for new conversations every 5 seconds (no spinner)
            const pollInterval = setInterval(() => {
                loadConversations(false);
            }, 5000);

            return () => clearInterval(pollInterval);
        }
    }, [user]);

    // Handle Compose Intent
    useEffect(() => {
        if (composeHandle && !selectedConversation && conversations.length >= 0) {
            // Check if we already have a conversation with this user
            const existing = conversations.find(c =>
                c.participant2.handle.toLowerCase() === composeHandle.toLowerCase()
            );

            if (existing) {
                setSelectedConversation(existing);
                // Clear the query param so refresh doesn't keep resetting state
                router.replace('/chat', { scroll: false });
            } else if (!loading) {
                // Fetch user details to create a draft conversation
                const fetchUserAndInitDraft = async () => {
                    try {
                        const res = await fetch(`/api/users/${encodeURIComponent(composeHandle)}`);
                        const data = await res.json();
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
                            setSelectedConversation(draftConv);
                            router.replace('/chat', { scroll: false });
                        } else {
                            // User not found, clear compose param to show list
                            console.error('User not found for compose');
                            router.replace('/chat');
                        }
                    } catch (e) {
                        console.error("Failed to load user for compose", e);
                        router.replace('/chat');
                    }
                };
                fetchUserAndInitDraft();
            }
        }
    }, [composeHandle, selectedConversation, conversations, loading, router]);

    // Redirect if not logged in
    useEffect(() => {
        if (user === null) {
            router.push('/login');
        }
    }, [user, router]);

    // Load messages when conversation is selected
    useEffect(() => {
        if (selectedConversation) {


            // Clear messages immediately to prevent flash
            setMessages([]);

            if (selectedConversation.id === 'new') {
                setLoadingMessages(false);
                return; // Don't load messages for new/draft conversation
            }

            setLoadingMessages(true);

            loadMessages(selectedConversation.id);
            markAsRead(selectedConversation.id);

            // Poll for new messages every 3 seconds
            const pollInterval = setInterval(() => {
                // Only load if still the same conversation
                if (selectedConversation.id !== 'new') {
                    loadMessages(selectedConversation.id);
                }
            }, 3000);

            return () => clearInterval(pollInterval);
        } else if (!selectedConversation) {
            // Clear messages when no conversation selected

            setMessages([]);
            setLoadingMessages(false);
        }
    }, [selectedConversation]);

    // Auto-scroll to bottom of messages only if user was already at bottom
    useEffect(() => {
        if (messagesEndRef.current && isAtBottom) {
            messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages, isAtBottom]);

    // ============================================
    // RENDER LOGIC
    // ============================================

    const filteredConversations = conversations.filter((conv) =>
        conv.participant2.displayName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        conv.participant2.handle.toLowerCase().includes(searchQuery.toLowerCase())
    );

    if (user === null) return null;

    // Prevent flash of list view while processing compose intent
    if (composeHandle && !selectedConversation) {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>
                <Loader2 className="animate-spin" size={32} />
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
                            onClick={() => setSelectedConversation(null)}
                            style={{ background: 'none', border: 'none', padding: '4px', cursor: 'pointer', color: 'var(--foreground)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        >
                            <ArrowLeft size={20} />
                        </button>
                        <div className="avatar" style={{ width: '32px', height: '32px', fontSize: '14px' }}>
                            {selectedConversation.participant2.avatarUrl ? (
                                <img src={selectedConversation.participant2.avatarUrl} alt="" />
                            ) : (
                                selectedConversation.participant2.displayName[0] || '?'
                            )}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: '15px' }}>{selectedConversation.participant2.displayName}</div>
                            <div style={{ fontSize: '12px', color: 'var(--foreground-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {selectedHandle}
                            </div>
                        </div>
                        <button
                            onClick={() => { setConversationToDelete(selectedConversation); setShowDeleteModal(true); }}
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
                    style={{
                        padding: '16px',
                        flex: 1,
                        overflowY: 'auto',
                        paddingBottom: '16px',
                        position: 'relative'
                    }}
                >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                        {messages.map((msg, i) => (
                            <div key={msg.id || i} style={{
                                display: 'flex',
                                gap: '12px',
                                maxWidth: '70%',
                                marginLeft: msg.isSentByMe ? 'auto' : '0',
                                flexDirection: msg.isSentByMe ? 'row-reverse' : 'row'
                            }}>
                                <div className="avatar avatar-sm" style={{ flexShrink: 0 }}>
                                    {msg.isSentByMe ? (
                                        user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : user.displayName[0]
                                    ) : (
                                        msg.senderAvatarUrl ? <img src={msg.senderAvatarUrl} alt="" /> : msg.senderDisplayName?.[0]
                                    )}
                                </div>

                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: msg.isSentByMe ? 'flex-end' : 'flex-start' }}>
                                    <div style={{
                                        padding: '10px 14px',
                                        borderRadius: '16px',
                                        background: msg.isSentByMe ? 'var(--accent)' : 'var(--background-secondary)',
                                        color: msg.isSentByMe ? '#000' : 'var(--foreground)',
                                        border: msg.isSentByMe ? 'none' : '1px solid var(--border)',
                                        wordBreak: 'break-word'
                                    }}>
                                        {msg.content}
                                    </div>
                                    <div style={{ fontSize: '11px', color: 'var(--foreground-tertiary)', marginTop: '4px' }}>
                                        {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                    </div>
                                </div>
                            </div>
                        ))}
                        <div ref={messagesEndRef} />
                    </div>
                </div>

                {/* Input */}
                <div className="compose" style={{ borderTop: '1px solid var(--border)', background: 'var(--background)', flexShrink: 0 }}>
                    <form onSubmit={handleSendMessage} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <input
                            type="text"
                            className="input"
                            style={{ flex: 1 }}
                            placeholder="Type a message..."
                            value={newMessage}
                            onChange={e => setNewMessage(e.target.value)}
                        />
                        <button type="submit" disabled={!newMessage.trim() || sending} className="btn btn-primary">
                            {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                        </button>
                    </form>
                </div>
                {/* Delete Modal */}
                {showDeleteModal && (
                    <div style={{
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
                            <h3 style={{ marginTop: 0, fontSize: '18px', fontWeight: 600 }}>Delete Conversation</h3>
                            <p style={{ color: 'var(--foreground-secondary)', fontSize: '14px', marginBottom: '24px' }}>
                                This action cannot be undone.
                            </p>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                <button
                                    disabled={isDeleting}
                                    onClick={() => handleDeleteConversation('self')}
                                    className="btn"
                                    style={{ justifyContent: 'center', width: '100%' }}
                                >
                                    Delete for me
                                </button>
                                <button
                                    disabled={isDeleting}
                                    onClick={() => handleDeleteConversation('both')}
                                    className="btn btn-danger" // Assuming btn-danger exists or falls back
                                    style={{ justifyContent: 'center', width: '100%', color: 'var(--destructive)', background: 'var(--destructive-10)' }}
                                >
                                    Delete for everyone
                                </button>
                                <button
                                    disabled={isDeleting}
                                    onClick={() => setShowDeleteModal(false)}
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
                        <Search size={16} style={{ color: 'var(--foreground-tertiary)' }} />
                        <input
                            type="text"
                            placeholder="Search..."
                            style={{ background: 'transparent', border: 'none', outline: 'none', flex: 1, color: 'var(--foreground)' }}
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                        />
                    </div>
                </div>
            </div>

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                {loading ? (
                    <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
                        <Loader2 className="animate-spin" size={32} />
                    </div>
                ) : filteredConversations.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--foreground-tertiary)' }}>
                        <MessageCircle size={48} style={{ margin: '0 auto 16px', opacity: 0.5 }} />
                        <p>No conversations yet</p>
                    </div>
                ) : (
                    filteredConversations.map(conv => (
                        <div
                            key={conv.id}
                            className="post"
                            onClick={() => {
                                setMessages([]);
                                setSelectedConversation(conv);
                            }}
                            style={{ cursor: 'pointer', display: 'flex', alignItems: 'flex-start', gap: '12px' }}
                        >
                            <div className="avatar">
                                {conv.participant2.avatarUrl ? <img src={conv.participant2.avatarUrl} alt="" /> : conv.participant2.displayName?.[0] || '?'}
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
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
