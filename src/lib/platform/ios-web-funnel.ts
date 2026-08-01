export const IOS_ACCOUNT_SETUP_PATH = '/login?app=ios';
export const IOS_APP_HANDOFF_PATH = '/continue-in-app';
export const IOS_APP_STORE_URL = 'https://apps.apple.com/us/app/synapsis-social/id6792197034';

/**
 * iPad remains outside the first release gate intentionally. Apple can make
 * iPadOS identify as desktop Safari, while iPhone and iPod retain an explicit
 * device token in both Safari and embedded browser user agents.
 */
export function isIPhoneUserAgent(userAgent: string | null | undefined): boolean {
    return /\b(?:iPhone|iPod)\b/i.test(userAgent || '');
}

export function getIPhoneWebDestination(authenticated: boolean): string {
    return authenticated ? IOS_APP_HANDOFF_PATH : IOS_ACCOUNT_SETUP_PATH;
}

export function getSafeIosPublicUrl(
    value: string | undefined,
    allowSynapsisScheme = false,
): string | null {
    if (!value) return null;
    try {
        const url = new URL(value);
        if (url.protocol === 'https:' || (allowSynapsisScheme && url.protocol === 'synapsis:')) {
            return url.toString();
        }
    } catch {
        // A missing or malformed release URL simply hides its button.
    }
    return null;
}

export function getIosAppStoreUrl(configuredUrl?: string): string {
    return getSafeIosPublicUrl(configuredUrl) || IOS_APP_STORE_URL;
}
