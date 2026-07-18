export interface AppRouterNavigation {
    replace: (href: string) => void;
}

/**
 * Finish authentication without reloading the JavaScript realm. The signing
 * key was just decrypted into memory during sign-in, so a hard reload would
 * immediately discard the strongest available copy of it.
 */
export function completePostSignInNavigation(
    router: AppRouterNavigation,
    onSuccess?: () => void,
): void {
    if (onSuccess) {
        onSuccess();
        return;
    }

    router.replace('/');
}
