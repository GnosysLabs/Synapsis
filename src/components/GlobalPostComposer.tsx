'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Compose } from '@/components/Compose';
import { signedAPI } from '@/lib/api/signed-fetch';
import { useAuth } from '@/lib/contexts/AuthContext';
import { useToast } from '@/lib/contexts/ToastContext';

export function GlobalPostComposer() {
    const { user, did, handle } = useAuth();
    const { showToast } = useToast();
    const [openForUserId, setOpenForUserId] = useState<string | null>(null);
    const open = Boolean(user && openForUserId === user.id);

    useEffect(() => {
        if (!user) return;

        const openComposer = () => setOpenForUserId(user.id);
        window.addEventListener('synapsis:open-post-composer', openComposer);
        return () => window.removeEventListener('synapsis:open-post-composer', openComposer);
    }, [user]);

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
                    >
                        <header className="global-compose-header">
                            <h2 id="global-compose-title">Create post</h2>
                            <button
                                type="button"
                                className="global-compose-close"
                                onClick={() => setOpenForUserId(null)}
                                aria-label="Close post composer"
                            >
                                <X size={22} />
                            </button>
                        </header>
                        <Compose
                            autoFocus
                            placeholder="What's happening?"
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
