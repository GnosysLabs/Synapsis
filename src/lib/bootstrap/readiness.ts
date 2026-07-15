export function isAppBootstrapReady({
    authLoading,
    configLoading,
}: {
    authLoading: boolean;
    configLoading: boolean;
}): boolean {
    return !authLoading && !configLoading;
}
