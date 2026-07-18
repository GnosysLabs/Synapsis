import { describe, expect, it } from 'vitest';

import { getLiveSearchQuery } from './live-search';

describe('getLiveSearchQuery', () => {
    it('starts searching after two username characters following @', () => {
        expect(getLiveSearchQuery('@t')).toBeNull();
        expect(getLiveSearchQuery('@th')).toBe('@th');
    });

    it('trims the query used for live search', () => {
        expect(getLiveSearchQuery('  red pill  ')).toBe('red pill');
    });
});
