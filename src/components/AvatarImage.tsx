'use client';

import Image from 'next/image';
import { useState, type ComponentProps } from 'react';
import { useAuth } from '@/lib/contexts/AuthContext';
import { useDomain, useRuntimeConfig } from '@/lib/contexts/ConfigContext';
import { shouldBlurProfileMedia } from '@/lib/nsfw/profile-media';
import { isRemoteAvatarSensitivityUnknown } from '@/lib/nsfw/content-visibility';
import { normalizeNodeDomain } from '@/lib/swarm/node-domain';
import { isTrustedFederationMediaUrl } from '@/lib/utils/federation';

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
    const qualifiedSeed = getDiceBearAvatarSeed(seed, nodeDomain, localNodeDomain);
    // Preserve the exact DiceBear bottts-neutral artwork while keeping the
    // viewer's browser on this Synapsis origin. `/avatar` performs the fixed,
    // bounded upstream request and returns a cacheable SVG.
    return `/avatar?seed=${encodeURIComponent(qualifiedSeed)}`;
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

export function AvatarImage({ avatarUrl, seed, isNsfw, nodeIsNsfw, nodeDomain, alt = '', width = 96, height = 96, onError, style, ...props }: AvatarImageProps) {
    const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null);
    const { user } = useAuth();
    const { config } = useRuntimeConfig();
    const localNodeDomain = useDomain();
    const customAvatar = avatarUrl?.trim();
    const handleDomain = seed.includes('@') ? seed.slice(seed.lastIndexOf('@') + 1) : null;
    const assertedDomain = nodeDomain || handleDomain;
    const isRemoteAvatar = Boolean(
        assertedDomain
        && normalizeNodeDomain(assertedDomain) !== normalizeNodeDomain(localNodeDomain)
    );
    const safeCustomAvatar = customAvatar
        && (!isRemoteAvatar || isTrustedFederationMediaUrl(customAvatar))
        ? customAvatar
        : null;
    const placeholderUrl = getDiceBearAvatarUrl(seed, nodeDomain, localNodeDomain);
    const localNodeClassificationKnown = config?.classificationKnown === true;
    const localNodeIsNsfw = localNodeClassificationKnown && config?.isNsfw === true;
    const sensitivityUnknown = isRemoteAvatarSensitivityUnknown({
        seed,
        nodeDomain,
        localNodeDomain,
        isNsfw,
        nodeIsNsfw,
    });
    const blurred = shouldBlurProfileMedia({
        accountIsNsfw: isNsfw === true || sensitivityUnknown || !localNodeClassificationKnown,
        nodeIsNsfw: nodeIsNsfw ?? localNodeIsNsfw,
        localNodeIsNsfw,
        viewer: user,
    });
    // Do not rely on CSS blur for access control: a blurred image still fetches
    // and exposes its original URL in the DOM. Restricted avatars use a
    // generated placeholder, so the sensitive URL never reaches the browser.
    const src = blurred
        ? placeholderUrl
        : safeCustomAvatar && failedAvatarUrl !== safeCustomAvatar
            ? safeCustomAvatar
            : placeholderUrl;

    return (
        <Image
            unoptimized
            referrerPolicy="no-referrer"
            {...props}
            src={src}
            alt={alt}
            width={width}
            height={height}
            style={style}
            onError={(event) => {
                onError?.(event);
                if (!blurred && safeCustomAvatar && failedAvatarUrl !== safeCustomAvatar) {
                    setFailedAvatarUrl(safeCustomAvatar);
                }
            }}
        />
    );
}
