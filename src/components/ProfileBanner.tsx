'use client';

import { useAuth } from '@/lib/contexts/AuthContext';
import { useRuntimeConfig } from '@/lib/contexts/ConfigContext';
import { shouldBlurProfileMedia } from '@/lib/nsfw/profile-media';

export function ProfileBanner({
    url,
    isNsfw = false,
    nodeIsNsfw,
    height,
    aspectRatio,
    borderBottom,
}: {
    url?: string | null;
    isNsfw?: boolean;
    nodeIsNsfw?: boolean;
    height?: string | number;
    aspectRatio?: string;
    borderBottom?: string;
}) {
    const { user } = useAuth();
    const { config } = useRuntimeConfig();
    const blurred = shouldBlurProfileMedia({
        accountIsNsfw: isNsfw,
        nodeIsNsfw: nodeIsNsfw ?? config?.isNsfw ?? false,
        viewer: user,
    });

    return (
        <div style={{ width: '100%', height, aspectRatio, overflow: 'hidden', borderBottom, position: 'relative' }}>
            <div
                aria-label={blurred ? 'Sensitive profile banner hidden' : undefined}
                style={{
                    position: 'absolute',
                    inset: 0,
                    background: url
                        ? `url(${url}) center/cover no-repeat`
                        : 'linear-gradient(135deg, var(--accent-muted) 0%, var(--background-tertiary) 100%)',
                    filter: blurred ? 'blur(20px)' : undefined,
                    transform: blurred ? 'scale(1.12)' : undefined,
                }}
            />
        </div>
    );
}
