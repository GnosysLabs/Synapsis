import { describe, expect, it } from 'vitest';
import {
    getIPhoneWebDestination,
    getIosAppStoreUrl,
    getSafeIosPublicUrl,
    IOS_ACCOUNT_SETUP_PATH,
    IOS_APP_HANDOFF_PATH,
    IOS_APP_STORE_URL,
    isIPhoneUserAgent,
} from './ios-web-funnel';

describe('iPhone web funnel', () => {
    it('recognizes iPhone browsers without gating iPad or desktop', () => {
        expect(isIPhoneUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe(true);
        expect(isIPhoneUserAgent('Mozilla/5.0 (iPod touch; CPU iPhone OS 17_0 like Mac OS X)')).toBe(true);
        expect(isIPhoneUserAgent('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)')).toBe(false);
        expect(isIPhoneUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(false);
    });

    it('routes account setup before authentication and hands off afterward', () => {
        expect(getIPhoneWebDestination(false)).toBe(IOS_ACCOUNT_SETUP_PATH);
        expect(getIPhoneWebDestination(true)).toBe(IOS_APP_HANDOFF_PATH);
    });

    it('accepts only safe release destinations', () => {
        expect(getSafeIosPublicUrl('https://apps.apple.com/app/id1')).toBe('https://apps.apple.com/app/id1');
        expect(getSafeIosPublicUrl('synapsis://', true)).toBe('synapsis://');
        expect(getSafeIosPublicUrl('javascript:alert(1)', true)).toBeNull();
    });

    it('uses the official App Store listing unless a safe override is configured', () => {
        expect(getIosAppStoreUrl()).toBe(IOS_APP_STORE_URL);
        expect(getIosAppStoreUrl('javascript:alert(1)')).toBe(IOS_APP_STORE_URL);
        expect(getIosAppStoreUrl('https://apps.apple.com/ca/app/synapsis/id1')).toBe(
            'https://apps.apple.com/ca/app/synapsis/id1',
        );
    });
});
