'use client';

import { useState, type ImgHTMLAttributes } from 'react';

export function getDiceBearAvatarUrl(seed: string): string {
    return `https://api.dicebear.com/9.x/bottts-neutral/svg?seed=${encodeURIComponent(seed)}`;
}

interface AvatarImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
    avatarUrl?: string | null;
    seed: string;
}

export function AvatarImage({ avatarUrl, seed, alt = '', onError, ...props }: AvatarImageProps) {
    const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null);
    const customAvatar = avatarUrl?.trim();
    const src = customAvatar && failedAvatarUrl !== customAvatar ? customAvatar : getDiceBearAvatarUrl(seed);

    return (
        <img
            {...props}
            src={src}
            alt={alt}
            onError={(event) => {
                onError?.(event);
                if (customAvatar && failedAvatarUrl !== customAvatar) setFailedAvatarUrl(customAvatar);
            }}
        />
    );
}
