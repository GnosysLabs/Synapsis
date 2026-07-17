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

    // Adult-only local nodes make sensitive viewing part of authenticated
    // membership and intentionally hide the per-account viewing toggle.
    if (localNodeIsNsfw) return false;

    if (!viewer.ageVerifiedAt) return true;
    return viewer.nsfwEnabled !== true;
}
