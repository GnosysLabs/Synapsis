import { describe, expect, it } from 'vitest';
import { shouldFailClosedBeforeConfigRefresh } from './config-refresh-policy';

describe('node config refresh policy', () => {
    it('keeps the current classification during focus and periodic freshness checks', () => {
        expect(shouldFailClosedBeforeConfigRefresh('focus')).toBe(false);
        expect(shouldFailClosedBeforeConfigRefresh('periodic')).toBe(false);
    });

    it('fails closed when another context reports a classification change', () => {
        expect(shouldFailClosedBeforeConfigRefresh('sync')).toBe(true);
    });
});
