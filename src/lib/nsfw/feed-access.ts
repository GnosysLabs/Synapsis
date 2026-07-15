export interface NsfwFeedViewer {
    nsfwEnabled?: boolean;
}

export function shouldIncludeNsfwFeed({
    viewer,
    localNodeIsNsfw,
}: {
    viewer: NsfwFeedViewer | null;
    localNodeIsNsfw: boolean;
}): boolean {
    if (!viewer) return false;

    // Signing in to an NSFW node is consent to view its feed. On other nodes,
    // the viewer's explicit account preference remains authoritative.
    return localNodeIsNsfw || viewer.nsfwEnabled === true;
}
