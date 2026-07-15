'use client';

import { useEffect, useState } from 'react';
import { PenLine, Plus, X } from 'lucide-react';
import { Compose } from '@/components/Compose';
import { AvatarImage } from '@/components/AvatarImage';
import { signedAPI } from '@/lib/api/signed-fetch';
import { useAuth } from '@/lib/contexts/AuthContext';
import { useToast } from '@/lib/contexts/ToastContext';

export function GlobalPostComposer() {
    const { user, did, handle } = useAuth();
    const { showToast } = useToast();
    const [openForUserId, setOpenForUserId] = useState<string | null>(null);
    const open = Boolean(user && openForUserId === user.id);

    useEffect(() => {
        if (!open) return;

        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpenForUserId(null);
        };
        window.addEventListener('keydown', handleKeyDown);

        return () => {
            document.body.style.overflow = previousOverflow;
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [open]);

    if (!user) return null;

    const handlePost = async (
        content: string,
        mediaIds: string[],
        linkPreview?: unknown,
        _replyToId?: string,
        isNsfw?: boolean,
    ): Promise<boolean> => {
        if (!did || !handle) {
            showToast('Your identity is still loading. Try again in a moment.', 'error');
            return false;
        }

        try {
            const response = await signedAPI.createPost(
                content,
                mediaIds,
                linkPreview,
                undefined,
                undefined,
                isNsfw || false,
                did,
                handle,
            );

            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                showToast(data.error || 'Failed to publish post.', 'error');
                return false;
            }

            return true;
        } catch (error) {
            showToast(error instanceof Error ? error.message : 'Failed to publish post.', 'error');
            return false;
        }
    };

    return (
        <>
            {!open && (
                <button
                    type="button"
                    className="global-compose-fab"
                    onClick={() => setOpenForUserId(user.id)}
                    aria-label="Create a post"
                    title="Create a post"
                >
                    <Plus size={28} strokeWidth={2.4} />
                </button>
            )}

            {open && (
                <div
                    className="global-compose-overlay"
                    onMouseDown={(event) => {
                        if (event.target === event.currentTarget) setOpenForUserId(null);
                    }}
                >
                    <section
                        className="global-compose-modal"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="global-compose-title"
                        aria-describedby="global-compose-description"
                    >
                        <header className="global-compose-header">
                            <div className="global-compose-heading">
                                <span className="global-compose-heading-icon" aria-hidden="true">
                                    <PenLine size={18} strokeWidth={2} />
                                </span>
                                <div>
                                    <h2 id="global-compose-title">New post</h2>
                                    <p id="global-compose-description">Share something with your network</p>
                                </div>
                            </div>
                            <button
                                type="button"
                                className="global-compose-close"
                                onClick={() => setOpenForUserId(null)}
                                aria-label="Close post composer"
                            >
                                <X size={22} />
                            </button>
                        </header>
                        <div className="global-compose-identity">
                            <span className="global-compose-avatar">
                                <AvatarImage
                                    avatarUrl={user.avatarUrl}
                                    seed={user.handle}
                                    isNsfw={user.isNsfw}
                                    alt=""
                                />
                            </span>
                            <div className="global-compose-identity-copy">
                                <span>{user.displayName || user.handle}</span>
                                <small>@{user.handle}</small>
                            </div>
                            <span className="global-compose-audience">Public</span>
                        </div>
                        <Compose
                            autoFocus
                            placeholder="What do you want to share?"
                            onPost={handlePost}
                            onPosted={() => {
                                setOpenForUserId(null);
                                showToast('Post published.', 'success');
                            }}
                        />
                    </section>
                </div>
            )}
        </>
    );
}
