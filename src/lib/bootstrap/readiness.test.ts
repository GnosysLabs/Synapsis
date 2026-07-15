import { describe, expect, it } from 'vitest';
import { isAppBootstrapReady } from './readiness';

describe('isAppBootstrapReady', () => {
    it('blocks route rendering while authentication is unresolved', () => {
        expect(isAppBootstrapReady({ authLoading: true, configLoading: false })).toBe(false);
    });

    it('blocks route rendering while node classification is unresolved', () => {
        expect(isAppBootstrapReady({ authLoading: false, configLoading: true })).toBe(false);
    });

    it('allows route rendering only after both dependencies are resolved', () => {
        expect(isAppBootstrapReady({ authLoading: false, configLoading: false })).toBe(true);
    });
});
