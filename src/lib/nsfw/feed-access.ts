export interface NsfwFeedViewer {
    nsfwEnabled?: boolean;
    ageVerifiedAt?: string | Date | null;
}

export function canAccessNodeFeed({
    isAuthenticated,
    localNodeIsNsfw,
}: {
    isAuthenticated: boolean;
    localNodeIsNsfw: boolean;
}): boolean {
    return isAuthenticated || !localNodeIsNsfw;
}

export function shouldIncludeNsfwFeed({
    viewer,
    localNodeIsNsfw,
}: {
    viewer: NsfwFeedViewer | null;
    localNodeIsNsfw: boolean;
}): boolean {
    if (!viewer) return false;

    // A node becoming adult-only is not age consent for accounts that already
    // existed there. Every viewer still needs their own persisted 18+
    // confirmation. Once confirmed, adult-node membership implies the viewing
    // preference because those nodes do not expose an account-level opt-out.
    if (!viewer.ageVerifiedAt) return false;
    return localNodeIsNsfw || viewer.nsfwEnabled === true;
}

export function canAccessSensitiveRemoteProfile({
    profileRequiresNsfw,
    viewer,
    localNodeIsNsfw,
}: {
    profileRequiresNsfw: boolean;
    viewer: NsfwFeedViewer | null;
    localNodeIsNsfw: boolean;
}): boolean {
    if (!profileRequiresNsfw) return true;
    return shouldIncludeNsfwFeed({ viewer, localNodeIsNsfw });
}
