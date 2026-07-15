export function hasPublishablePostContent(
    content: string,
    mediaIds: readonly string[] | undefined,
): boolean {
    return content.trim().length > 0 || (mediaIds?.length ?? 0) > 0;
}
