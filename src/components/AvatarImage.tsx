'use client';

import Image from 'next/image';
import { useState, type ComponentProps } from 'react';
import { useAuth } from '@/lib/contexts/AuthContext';
import { useDomain, useRuntimeConfig } from '@/lib/contexts/ConfigContext';
import { shouldBlurProfileMedia } from '@/lib/nsfw/profile-media';
import { isRemoteAvatarSensitivityUnknown } from '@/lib/nsfw/content-visibility';
import { normalizeNodeDomain } from '@/lib/swarm/node-domain';
import { isTrustedFederationMediaUrl } from '@/lib/utils/federation';
import { resolveAccountAddress } from '@/lib/identity/account-address';
import { useProfilePresentation } from '@/lib/contexts/ProfilePresentationContext';

export function getDiceBearAvatarSeed(
    seed: string,
    nodeDomain?: string | null,
    localNodeDomain?: string | null,
): string {
    const effectiveDomain = nodeDomain || localNodeDomain;
    const address = resolveAccountAddress(seed, effectiveDomain);
    return address?.canonical || seed.trim().replace(/^@/, '');
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
    const { presentation, resolved } = useProfilePresentation(
        seed,
        nodeDomain || localNodeDomain,
    );
    // Props are an immediate rendering hint only. Once the shared registry has
    // answered, every AvatarImage in the application uses the same verified
    // account presentation instead of keeping feature-local avatar copies.
    const effectiveAvatarUrl = resolved ? presentation?.avatarUrl ?? null : avatarUrl;
    const effectiveNodeDomain = presentation?.nodeDomain || nodeDomain;
    const effectiveIsNsfw = presentation?.isNsfw ?? isNsfw;
    const effectiveNodeIsNsfw = presentation?.nodeIsNsfw ?? nodeIsNsfw;
    const customAvatar = effectiveAvatarUrl?.trim();
    const handleDomain = resolveAccountAddress(seed, effectiveNodeDomain || localNodeDomain)?.homeDomain ?? null;
    const assertedDomain = handleDomain
        || resolveAccountAddress('account', effectiveNodeDomain)?.homeDomain
        || null;
    const isRemoteAvatar = Boolean(
        assertedDomain
        && normalizeNodeDomain(assertedDomain) !== normalizeNodeDomain(localNodeDomain)
    );
    const safeCustomAvatar = customAvatar
        && (!isRemoteAvatar || isTrustedFederationMediaUrl(customAvatar))
        ? customAvatar
        : null;
    const placeholderUrl = getDiceBearAvatarUrl(seed, effectiveNodeDomain, localNodeDomain);
    const localNodeClassificationKnown = config?.classificationKnown === true;
    const localNodeIsNsfw = localNodeClassificationKnown && config?.isNsfw === true;
    const sensitivityUnknown = isRemoteAvatarSensitivityUnknown({
        seed,
        nodeDomain: effectiveNodeDomain,
        localNodeDomain,
        isNsfw: effectiveIsNsfw,
        nodeIsNsfw: effectiveNodeIsNsfw,
    });
    const blurred = shouldBlurProfileMedia({
        accountIsNsfw: effectiveIsNsfw === true || sensitivityUnknown || !localNodeClassificationKnown,
        nodeIsNsfw: effectiveNodeIsNsfw ?? localNodeIsNsfw,
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
