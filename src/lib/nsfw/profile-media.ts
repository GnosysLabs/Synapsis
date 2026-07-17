export interface ProfileMediaViewer {
    nsfwEnabled?: boolean;
    ageVerifiedAt?: string | Date | null;
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

    if (!viewer.ageVerifiedAt) return true;
    return !localNodeIsNsfw && viewer.nsfwEnabled !== true;
}
