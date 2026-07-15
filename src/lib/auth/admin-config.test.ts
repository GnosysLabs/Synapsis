import { describe, expect, it } from 'vitest';
import { configuredAdminEmails, isConfiguredAdminEmail } from './admin-config';

describe('admin configuration', () => {
    it('normalizes and deduplicates configured admin emails', () => {
        expect(configuredAdminEmails(' Admin@Example.com,owner@example.com,admin@example.com ')).toEqual([
            'admin@example.com',
            'owner@example.com',
        ]);
    });

    it('matches admin emails case-insensitively', () => {
        expect(isConfiguredAdminEmail('ADMIN@example.com', 'admin@example.com')).toBe(true);
        expect(isConfiguredAdminEmail('member@example.com', 'admin@example.com')).toBe(false);
        expect(isConfiguredAdminEmail(null, 'admin@example.com')).toBe(false);
    });
});
