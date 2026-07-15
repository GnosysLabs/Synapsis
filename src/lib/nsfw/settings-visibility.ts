export function shouldExposeAccountNsfwSettings(nodeIsNsfw: boolean): boolean {
    return !nodeIsNsfw;
}
