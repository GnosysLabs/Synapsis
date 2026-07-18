import { describe, expect, it } from 'vitest';
import { getToastBackground } from './toast-presentation';

describe('toast presentation', () => {
    it('gives error toasts an explicit background with a fallback color', () => {
        expect(getToastBackground('error')).toBe('var(--error, #ef4444)');
    });

    it('keeps the established success and info backgrounds', () => {
        expect(getToastBackground('success')).toBe('var(--accent)');
        expect(getToastBackground('info')).toBe('var(--background-secondary)');
    });
});
