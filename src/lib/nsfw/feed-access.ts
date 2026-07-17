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

    // Authentication alone is not age consent. Adult-only nodes may imply the
    // viewing preference, but every viewer still needs a persisted 18+
    // confirmation before raw sensitive data can leave the server.
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
