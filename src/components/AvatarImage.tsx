'use client';

import Image from 'next/image';
import { useState, type ComponentProps } from 'react';
import { useAuth } from '@/lib/contexts/AuthContext';
import { useDomain, useRuntimeConfig } from '@/lib/contexts/ConfigContext';
import { shouldBlurProfileMedia } from '@/lib/nsfw/profile-media';

export function getDiceBearAvatarSeed(
    seed: string,
    nodeDomain?: string | null,
    localNodeDomain?: string | null,
): string {
    const cleanSeed = seed.trim().replace(/^@/, '');
    const effectiveDomain = nodeDomain || localNodeDomain;
    const cleanDomain = effectiveDomain?.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');

    if (!cleanSeed || cleanSeed.includes('@') || !cleanDomain) return cleanSeed;
    return `${cleanSeed}@${cleanDomain}`;
}

export function getDiceBearAvatarUrl(
    seed: string,
    nodeDomain?: string | null,
    localNodeDomain?: string | null,
): string {
    return `https://api.dicebear.com/9.x/bottts-neutral/svg?seed=${encodeURIComponent(getDiceBearAvatarSeed(seed, nodeDomain, localNodeDomain))}`;
}

interface AvatarImageProps extends Omit<ComponentProps<typeof Image>, 'src' | 'alt' | 'width' | 'height'> {
    avatarUrl?: string | null;
    seed: string;
    isNsfw?: boolean;
    nodeIsNsfw?: boolean;
    nodeDomain?: string | null;
    alt?: string;
    width?: number;
    height?: number;
}

export function AvatarImage({ avatarUrl, seed, isNsfw = false, nodeIsNsfw, nodeDomain, alt = '', width = 96, height = 96, onError, style, ...props }: AvatarImageProps) {
    const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null);
    const { user } = useAuth();
    const { config } = useRuntimeConfig();
    const localNodeDomain = useDomain();
    const customAvatar = avatarUrl?.trim();
    const src = customAvatar && failedAvatarUrl !== customAvatar
        ? customAvatar
        : getDiceBearAvatarUrl(seed, nodeDomain, localNodeDomain);
    const localNodeIsNsfw = config?.isNsfw ?? false;
    const blurred = shouldBlurProfileMedia({
        accountIsNsfw: isNsfw,
        nodeIsNsfw: nodeIsNsfw ?? localNodeIsNsfw,
        localNodeIsNsfw,
        viewer: user,
    });

    return (
        <Image
            unoptimized
            {...props}
            src={src}
            alt={alt}
            width={width}
            height={height}
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
