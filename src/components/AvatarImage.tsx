'use client';

import { useState, type ImgHTMLAttributes } from 'react';
import { useAuth } from '@/lib/contexts/AuthContext';
import { useRuntimeConfig } from '@/lib/contexts/ConfigContext';
import { shouldBlurProfileMedia } from '@/lib/nsfw/profile-media';

export function getDiceBearAvatarUrl(seed: string): string {
    return `https://api.dicebear.com/9.x/bottts-neutral/svg?seed=${encodeURIComponent(seed)}`;
}

interface AvatarImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
    avatarUrl?: string | null;
    seed: string;
    isNsfw?: boolean;
    nodeIsNsfw?: boolean;
}

export function AvatarImage({ avatarUrl, seed, isNsfw = false, nodeIsNsfw, alt = '', onError, style, ...props }: AvatarImageProps) {
    const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null);
    const { user } = useAuth();
    const { config } = useRuntimeConfig();
    const customAvatar = avatarUrl?.trim();
    const src = customAvatar && failedAvatarUrl !== customAvatar ? customAvatar : getDiceBearAvatarUrl(seed);
    const localNodeIsNsfw = config?.isNsfw ?? false;
    const blurred = shouldBlurProfileMedia({
        accountIsNsfw: isNsfw,
        nodeIsNsfw: nodeIsNsfw ?? localNodeIsNsfw,
        localNodeIsNsfw,
        viewer: user,
    });

    return (
        <img
            {...props}
            src={src}
            alt={alt}
            style={{
                ...style,
                filter: blurred ? 'blur(12px)' : style?.filter,
                transform: blurred ? 'scale(1.12)' : style?.transform,
            }}
            onError={(event) => {
                onError?.(event);
                if (customAvatar && failedAvatarUrl !== customAvatar) setFailedAvatarUrl(customAvatar);
            }}
        />
    );
}
