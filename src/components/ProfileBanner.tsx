'use client';

import { useAuth } from '@/lib/contexts/AuthContext';
import { useDomain, useRuntimeConfig } from '@/lib/contexts/ConfigContext';
import { isRemoteAvatarSensitivityUnknown } from '@/lib/nsfw/content-visibility';
import { shouldBlurProfileMedia } from '@/lib/nsfw/profile-media';

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
}) {
    const { user } = useAuth();
    const { config } = useRuntimeConfig();
    const localNodeDomain = useDomain();
    const localNodeClassificationKnown = config?.classificationKnown === true;
    const localNodeIsNsfw = localNodeClassificationKnown && config?.isNsfw === true;
    const inferredRemoteSensitivityUnknown = isRemoteAvatarSensitivityUnknown({
        seed: accountHandle,
        nodeDomain,
        localNodeDomain,
        isNsfw,
        nodeIsNsfw,
    });
    const explicitRemoteSensitivityUnknown = isRemote === true && (
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

    return (
        <div style={{ width: '100%', height, aspectRatio, overflow: 'hidden', borderBottom, position: 'relative' }}>
            <div
                aria-label={blurred ? 'Sensitive profile banner hidden' : undefined}
                style={{
                    position: 'absolute',
                    inset: 0,
                    // A CSS blur still downloads and exposes the source URL.
                    // Restricted banners must never put that URL in the DOM.
                    background: url && !blurred
                        ? `url(${url}) center/cover no-repeat`
                        : 'linear-gradient(135deg, var(--accent-muted) 0%, var(--background-tertiary) 100%)',
                }}
            />
        </div>
    );
}
