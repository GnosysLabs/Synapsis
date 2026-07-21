'use client';

import Image from 'next/image';
import { useAuth } from '@/lib/contexts/AuthContext';
import { useDomain, useRuntimeConfig } from '@/lib/contexts/ConfigContext';
import { isRemoteAvatarSensitivityUnknown } from '@/lib/nsfw/content-visibility';
import { shouldBlurProfileMedia } from '@/lib/nsfw/profile-media';
import { isTrustedFederationMediaUrl } from '@/lib/utils/federation';
import { isAccountOnNode, resolveAccountAddress } from '@/lib/identity/account-address';

export function ProfileBanner({
    url,
    accountHandle = '',
    isRemote,
    nodeDomain,
    isNsfw,
    nodeIsNsfw,
    height,
    aspectRatio,
    borderBottom,
    showBlurredSourceToSignedOutViewers = false,
}: {
    url?: string | null;
    accountHandle?: string;
    isRemote?: boolean;
    nodeDomain?: string | null;
    isNsfw?: boolean;
    nodeIsNsfw?: boolean;
    height?: string | number;
    aspectRatio?: string;
    borderBottom?: string;
    showBlurredSourceToSignedOutViewers?: boolean;
}) {
    const { user } = useAuth();
    const { config } = useRuntimeConfig();
    const localNodeDomain = useDomain();
    const accountAddress = resolveAccountAddress(
        accountHandle,
        nodeDomain || localNodeDomain,
    );
    const nodeAddress = nodeDomain ? resolveAccountAddress('account', nodeDomain) : null;
    const assertedAddress = accountAddress || nodeAddress;
    const effectiveIsRemote = isRemote === true
        || Boolean(assertedAddress && !isAccountOnNode(assertedAddress.canonical, localNodeDomain));
    const localNodeClassificationKnown = config?.classificationKnown === true;
    const localNodeIsNsfw = localNodeClassificationKnown && config?.isNsfw === true;
    const inferredRemoteSensitivityUnknown = isRemoteAvatarSensitivityUnknown({
        seed: accountHandle,
        nodeDomain,
        localNodeDomain,
        isNsfw,
        nodeIsNsfw,
    });
    const explicitRemoteSensitivityUnknown = effectiveIsRemote && (
        typeof isNsfw !== 'boolean'
        || typeof nodeIsNsfw !== 'boolean'
    );
    const blurred = shouldBlurProfileMedia({
        accountIsNsfw: isNsfw === true
            || inferredRemoteSensitivityUnknown
            || explicitRemoteSensitivityUnknown
            || !localNodeClassificationKnown,
        nodeIsNsfw: nodeIsNsfw ?? localNodeIsNsfw,
        localNodeIsNsfw,
        viewer: user,
    });
    const safeUrl = url && (!effectiveIsRemote || isTrustedFederationMediaUrl(url))
        ? url
        : null;
    const showBlurredSource = Boolean(
        safeUrl
        && blurred
        && !user
        && nodeIsNsfw === true
        && showBlurredSourceToSignedOutViewers
    );

    return (
        <div style={{ width: '100%', height, aspectRatio, overflow: 'hidden', borderBottom, position: 'relative' }}>
            {safeUrl && (!blurred || showBlurredSource) ? (
                // A real image element keeps attacker-controlled URLs out of a
                // CSS declaration and lets us explicitly suppress referrers.
                <Image
                    unoptimized
                    src={safeUrl}
                    alt=""
                    aria-label={showBlurredSource ? 'NSFW node banner blurred' : undefined}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    fill
                    sizes="100vw"
                    style={{
                        position: 'absolute',
                        inset: 0,
                        objectFit: 'cover',
                        filter: showBlurredSource ? 'blur(18px) brightness(0.72)' : undefined,
                        transform: showBlurredSource ? 'scale(1.05)' : undefined,
                    }}
                />
            ) : (
                <div
                    aria-label={blurred ? 'Sensitive profile banner hidden' : undefined}
                    style={{
                        position: 'absolute',
                        inset: 0,
                        background: 'linear-gradient(135deg, var(--accent-muted) 0%, var(--background-tertiary) 100%)',
                    }}
                />
            )}
        </div>
    );
}
