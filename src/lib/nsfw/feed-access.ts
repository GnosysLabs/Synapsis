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

    // Signing in to a permanently adult-only node is the viewing opt-in. Those
    // nodes do not expose an account-level NSFW toggle, so requiring that
    // hidden preference (or a newer per-user age field) would lock legacy
    // members out of their own node.
    if (localNodeIsNsfw) return true;

    // General-purpose nodes require both persisted age confirmation and the
    // explicit account preference.
    if (!viewer.ageVerifiedAt) return false;
    return viewer.nsfwEnabled === true;
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
