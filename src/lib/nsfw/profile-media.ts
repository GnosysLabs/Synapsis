export interface ProfileMediaViewer {
    nsfwEnabled?: boolean;
}

export function shouldBlurProfileMedia({
    accountIsNsfw = false,
    nodeIsNsfw = false,
    localNodeIsNsfw = false,
    viewer,
}: {
    accountIsNsfw?: boolean;
    nodeIsNsfw?: boolean;
    localNodeIsNsfw?: boolean;
    viewer: ProfileMediaViewer | null;
}): boolean {
    if (!accountIsNsfw && !nodeIsNsfw) return false;
    if (!viewer) return true;

    // Signing in to an NSFW node is itself consent to view that node's media.
    // The explicit preference still controls sensitive media on non-NSFW nodes.
    return viewer.nsfwEnabled !== true && !localNodeIsNsfw;
}
