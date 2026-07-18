'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, MessageCircle, Search, UserRoundSearch, X } from 'lucide-react';

import { AvatarImage } from '@/components/AvatarImage';
import {
    recentChatRecipients,
    uniqueChatRecipients,
    type ChatRecipient,
} from '@/lib/chat/recipients';

interface ChatRecipientPickerProps {
    currentUserHandle?: string | null;
    onClose: () => void;
    onSelect: (recipient: ChatRecipient) => void;
}

interface ConversationResponse {
    conversations?: unknown[];
    error?: string;
}

interface SuggestionResponse {
    suggestions?: unknown[];
    error?: string;
}

interface RecipientSearchState {
    query: string;
    loading: boolean;
    results: ChatRecipient[];
    error: string | null;
}

export function ChatRecipientPicker({ currentUserHandle, onClose, onSelect }: ChatRecipientPickerProps) {
    const [query, setQuery] = useState('');
    const [recentRecipients, setRecentRecipients] = useState<ChatRecipient[]>([]);
    const [loadingRecents, setLoadingRecents] = useState(true);
    const [recentsError, setRecentsError] = useState<string | null>(null);
    const [searchState, setSearchState] = useState<RecipientSearchState>({
        query: '',
        loading: false,
        results: [],
        error: null,
    });
    const titleId = useId();
    const descriptionId = useId();
    const pickerRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const onCloseRef = useRef(onClose);
    const normalizedQuery = query.trim().replace(/^@/, '');

    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
        const controller = new AbortController();
        void fetch('/api/swarm/chat/conversations', {
            cache: 'no-store',
            signal: controller.signal,
        }).then(async (response) => {
            const data = await response.json().catch(() => ({})) as ConversationResponse;
            if (!response.ok) throw new Error(data.error || 'Could not load recent chats');
            setRecentRecipients(recentChatRecipients(data.conversations, currentUserHandle).slice(0, 8));
        }).catch((error) => {
            if (!controller.signal.aborted) {
                setRecentsError(error instanceof Error ? error.message : 'Could not load recent chats');
            }
        }).finally(() => {
            if (!controller.signal.aborted) setLoadingRecents(false);
        });
        return () => controller.abort();
    }, [currentUserHandle]);

    useEffect(() => {
        if (!normalizedQuery) return;

        const controller = new AbortController();
        const timeout = window.setTimeout(() => {
            setSearchState({ query: normalizedQuery, loading: true, results: [], error: null });
            void fetch(`/api/mentions/suggestions?q=${encodeURIComponent(normalizedQuery)}&limit=10`, {
                cache: 'no-store',
                signal: controller.signal,
            }).then(async (response) => {
                const data = await response.json().catch(() => ({})) as SuggestionResponse;
                if (!response.ok) throw new Error(data.error || 'Search failed');
                setSearchState({
                    query: normalizedQuery,
                    loading: false,
                    results: uniqueChatRecipients(data.suggestions, currentUserHandle),
                    error: null,
                });
            }).catch((error) => {
                if (!controller.signal.aborted) {
                    setSearchState({
                        query: normalizedQuery,
                        loading: false,
                        results: [],
                        error: error instanceof Error ? error.message : 'Search failed',
                    });
                }
            });
        }, 220);

        return () => {
            window.clearTimeout(timeout);
            controller.abort();
        };
    }, [currentUserHandle, normalizedQuery]);

    useEffect(() => {
        const previouslyFocused = document.activeElement as HTMLElement | null;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const focusFrame = window.requestAnimationFrame(() => searchInputRef.current?.focus());

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onCloseRef.current();
                return;
            }
            if (event.key !== 'Tab' || !pickerRef.current) return;
            const focusable = Array.from(pickerRef.current.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ));
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => {
            window.cancelAnimationFrame(focusFrame);
            document.removeEventListener('keydown', handleKeyDown);
            document.body.style.overflow = previousOverflow;
            previouslyFocused?.focus();
        };
    }, []);

    if (typeof document === 'undefined') return null;

    const currentSearch = searchState.query === normalizedQuery ? searchState : null;
    const recipients = normalizedQuery ? currentSearch?.results || [] : recentRecipients;
    const loading = normalizedQuery ? !currentSearch || currentSearch.loading : loadingRecents;
    const error = normalizedQuery ? currentSearch?.error || null : recentsError;

    return createPortal(
        <div
            className="app-dialog-backdrop chat-recipient-picker-backdrop"
            onClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => {
                event.stopPropagation();
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
                ref={pickerRef}
                className="chat-recipient-picker"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={descriptionId}
            >
                <header className="chat-recipient-picker-header">
                    <div>
                        <h2 id={titleId}>Send in Chat</h2>
                        <p id={descriptionId}>Choose a recent contact or find someone new.</p>
                    </div>
                    <button type="button" className="chat-recipient-picker-close" onClick={onClose} aria-label="Close recipient picker">
                        <X size={19} aria-hidden="true" />
                    </button>
                </header>

                <div className="chat-recipient-search">
                    <Search size={18} aria-hidden="true" />
                    <input
                        ref={searchInputRef}
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search name or @handle"
                        aria-label="Search for a chat recipient"
                    />
                    {normalizedQuery && loading && <Loader2 className="animate-spin" size={17} aria-label="Searching" />}
                </div>

                <div className="chat-recipient-picker-body" aria-live="polite">
                    <div className="chat-recipient-picker-section-title">
                        {normalizedQuery ? 'People' : 'Recent contacts'}
                    </div>

                    {loading && recipients.length === 0 ? (
                        <div className="chat-recipient-picker-state" aria-busy="true">
                            <Loader2 className="animate-spin" size={24} aria-hidden="true" />
                            <span>{normalizedQuery ? 'Searching…' : 'Loading recent contacts…'}</span>
                        </div>
                    ) : error ? (
                        <div className="chat-recipient-picker-state" role="alert">
                            <span>{error}</span>
                        </div>
                    ) : recipients.length === 0 ? (
                        <div className="chat-recipient-picker-state">
                            {normalizedQuery ? <UserRoundSearch size={28} aria-hidden="true" /> : <MessageCircle size={28} aria-hidden="true" />}
                            <span>{normalizedQuery ? 'No matching people found.' : 'No recent contacts yet. Search for someone above.'}</span>
                        </div>
                    ) : (
                        <div className="chat-recipient-list">
                            {recipients.map((recipient) => (
                                <button
                                    type="button"
                                    className="chat-recipient-row"
                                    key={recipient.handle.toLowerCase()}
                                    onClick={() => onSelect(recipient)}
                                >
                                    <span className="avatar">
                                        <AvatarImage
                                            avatarUrl={recipient.avatarUrl}
                                            seed={recipient.handle}
                                            nodeDomain={recipient.nodeDomain}
                                            isNsfw={recipient.isNsfw}
                                            nodeIsNsfw={recipient.nodeIsNsfw}
                                            alt=""
                                        />
                                    </span>
                                    <span className="chat-recipient-copy">
                                        <strong>{recipient.displayName || recipient.handle}</strong>
                                        <span>@{recipient.handle.replace(/^@/, '')}</span>
                                    </span>
                                    <span className="chat-recipient-action">Open chat</span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                <footer className="chat-recipient-picker-footer">
                    Search by name or <strong>@handle</strong> across Synapsis nodes.
                </footer>
            </div>
        </div>,
        document.body,
    );
}
