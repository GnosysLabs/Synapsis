import { describe, expect, it } from 'vitest';
import { registrationDisplayName } from './display-name';

describe('registrationDisplayName', () => {
    it('uses the handle when no display name was provided', () => {
        expect(registrationDisplayName('alice', 'alice@example.com')).toBe('alice');
    });

    it('does not expose an autofilled email as the public display name', () => {
        expect(registrationDisplayName('alice', 'alice@example.com', ' Alice@Example.com ')).toBe('alice');
    });

    it('trims and preserves an intentional display name', () => {
        expect(registrationDisplayName('alice', 'alice@example.com', ' Alice Example ')).toBe('Alice Example');
    });
});
