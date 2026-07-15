export interface ProfileMediaViewer {
    nsfwEnabled?: boolean;
}

export function shouldBlurProfileMedia({
    accountIsNsfw = false,
    nodeIsNsfw = false,
    viewer,
}: {
    accountIsNsfw?: boolean;
    nodeIsNsfw?: boolean;
    viewer: ProfileMediaViewer | null;
}): boolean {
    return (accountIsNsfw || nodeIsNsfw) && viewer?.nsfwEnabled !== true;
}
