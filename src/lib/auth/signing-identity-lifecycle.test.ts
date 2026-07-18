import { describe, expect, it } from 'vitest';
import { canReuseUnlockedSigningIdentity } from './signing-identity-lifecycle';

describe('signing identity lifecycle', () => {
    it('keeps an unlocked key when auth refreshes the same account', () => {
        expect(canReuseUnlockedSigningIdentity({
            currentDid: 'did:key:alice',
            requestedDid: 'did:key:alice',
            hasPrivateKey: true,
        })).toBe(true);
    });

    it('does not carry a key into a different account or a locked session', () => {
        expect(canReuseUnlockedSigningIdentity({
            currentDid: 'did:key:alice',
            requestedDid: 'did:key:bob',
            hasPrivateKey: true,
        })).toBe(false);
        expect(canReuseUnlockedSigningIdentity({
            currentDid: 'did:key:alice',
            requestedDid: 'did:key:alice',
            hasPrivateKey: false,
        })).toBe(false);
    });
});
