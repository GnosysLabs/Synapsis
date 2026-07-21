/**
 * Property Tests for Cryptographic User Signing
 * 
 * Verifies:
 * 1. Key generation and storage
 * 2. Canonical serialization
 * 3. Signing process
 * 4. Verification process
 * 5. Replay protection logic (mocked DB)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    generateKeyPair,
    keyStore,
    createSignedAction,
    canonicalize,
    exportPublicKey
} from './user-signing';
import { verifyUserAction } from '../auth/verify-signature';

const { mockIsRateLimited } = vi.hoisted(() => ({
    mockIsRateLimited: vi.fn(() => false),
}));

vi.mock('@/lib/rate-limit', () => ({
    isRateLimited: mockIsRateLimited,
}));

// We need to hoist the variable if we use it in vi.mock
// Or simpler for this case, simply define it inline or use a factory that doesn't capture outer scope incorrectly.
vi.mock('@/db', () => ({
    db: {
        query: {
            users: { findFirst: vi.fn() },
            remoteIdentityCache: { findFirst: vi.fn() }
        },
        select: vi.fn(() => ({
            from: vi.fn(() => ({
                where: vi.fn(() => ({
                    limit: vi.fn().mockResolvedValue([]),
                })),
            })),
        })),
        insert: vi.fn(() => ({ values: vi.fn() })),
        delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    },
    users: { did: 'did', publicKey: 'publicKey' },
    signedActionDedupe: { actionId: 'actionId' },
    remoteIdentityCache: { did: 'did' },
}));

// Access the mocked module to manipulate it in tests
import { db } from '@/db';

describe('Cryptographic User Signing', () => {
    let userKeyPair: CryptoKeyPair;
    let userPublicKeyBase64: string;
    const testDid = 'did:web:test.com:alice';
    const testHandle = 'alice';

    beforeEach(async () => {
        // Setup fresh identity
        userKeyPair = await generateKeyPair();
        keyStore.setPrivateKey(userKeyPair.privateKey);
        userPublicKeyBase64 = await exportPublicKey(userKeyPair.publicKey);

        vi.clearAllMocks();
        mockIsRateLimited.mockReturnValue(false);
    });

    it('should canonicalize objects strictly', () => {
        const obj1 = { b: 1, a: 2 };
        const obj2 = { a: 2, b: 1 };

        expect(canonicalize(obj1)).toBe('{"a":2,"b":1}');
        expect(canonicalize(obj2)).toBe('{"a":2,"b":1}');
        expect(canonicalize(obj1)).toBe(canonicalize(obj2));
    });

    it('should throw on invalid canonical types', () => {
        expect(() => canonicalize({ d: new Date() })).toThrow(/Date objects not allowed/);
        expect(() => canonicalize({ n: NaN })).toThrow(/Number is not finite/);
    });

    it('should create a valid signed action', async () => {
        const payload = { content: 'Hello World' };
        const action = 'create_post';

        const signed = await createSignedAction(action, payload, testDid, testHandle);

        expect(signed).toHaveProperty('sig');
        expect(signed).toHaveProperty('nonce');
        expect(signed).toHaveProperty('ts');
        expect(signed.action).toBe(action);
        expect(signed.did).toBe(testDid);
    });

    it('should verify a valid signed action', async () => {
        const payload = { content: 'Hello World' };
        const signed = await createSignedAction('create_post', payload, testDid, testHandle);

        // Mock DB finding the user
        vi.mocked(db.query.users.findFirst).mockResolvedValue({
            id: 'uuid-123',
            did: testDid,
            handle: testHandle,
            publicKey: userPublicKeyBase64,
        } as never);

        // Mock DB insert (dedupe) success
        vi.mocked(db.insert).mockReturnValue({
            values: vi.fn().mockResolvedValue(true)
        } as never);

        const result = await verifyUserAction(signed);

        expect(result.valid).toBe(true);
        expect(result.user).toBeDefined();
        // Verify dedupe insert was called
        expect(db.insert).toHaveBeenCalled();
    });

    it('should reject invalid signature', async () => {
        const payload = { content: 'Hello World' };
        const signed = await createSignedAction('create_post', payload, testDid, testHandle);

        // Tamper with data
        signed.data.content = 'Hacked';

        vi.mocked(db.query.users.findFirst).mockResolvedValue({
            id: 'uuid-123',
            did: testDid,
            handle: testHandle,
            publicKey: userPublicKeyBase64,
        } as never);
        const result = await verifyUserAction(signed);

        expect(result.valid).toBe(false);
        expect(result.error).toBe('INVALID_SIGNATURE');
    });

    it('should reject replay attacks via DB constraint', async () => {
        const payload = { content: 'Replay Me' };
        const signed = await createSignedAction('create_post', payload, testDid, testHandle);

        vi.mocked(db.query.users.findFirst).mockResolvedValue({
            id: 'uuid-123',
            did: testDid,
            handle: testHandle,
            publicKey: userPublicKeyBase64,
        } as never);

        // Mock Duplicate Key Error
        const duplicateKeyError = Object.assign(new Error('Duplicate key'), { code: '23505' });

        // Second attempt fails with unique violation
        vi.mocked(db.insert).mockReturnValue({
            values: vi.fn().mockRejectedValue(duplicateKeyError)
        } as never);

        // Verify failure path
        const result = await verifyUserAction(signed);
        expect(result.valid).toBe(false);
        expect(result.error).toBe('REPLAYED_NONCE');
    });

    it('should not persist a unique action rejected by the authenticated rate limit', async () => {
        const signed = await createSignedAction(
            'create_post',
            { content: 'Over limit' },
            testDid,
            testHandle,
        );

        vi.mocked(db.query.users.findFirst).mockResolvedValue({
            id: 'uuid-123',
            did: testDid,
            handle: testHandle,
            publicKey: userPublicKeyBase64,
        } as never);
        mockIsRateLimited.mockReturnValue(true);

        const result = await verifyUserAction(signed);

        expect(result).toEqual({ valid: false, error: 'RATE_LIMITED' });
        expect(db.select).toHaveBeenCalledOnce();
        expect(mockIsRateLimited).toHaveBeenCalledOnce();
        expect(db.insert).not.toHaveBeenCalled();
    });

    it('allows normal bursts of follow actions without using the five-action default', async () => {
        const signed = await createSignedAction(
            'follow',
            { targetHandle: 'bob' },
            testDid,
            testHandle,
        );

        vi.mocked(db.query.users.findFirst).mockResolvedValue({
            id: 'uuid-123',
            did: testDid,
            handle: testHandle,
            publicKey: userPublicKeyBase64,
        } as never);
        vi.mocked(db.insert).mockReturnValue({
            values: vi.fn().mockResolvedValue(true),
        } as never);

        const result = await verifyUserAction(signed);

        expect(result.valid).toBe(true);
        expect(mockIsRateLimited).toHaveBeenCalledWith('uuid-123:follow', 30, 60 * 1000);
    });

    it('should reject an existing replay without charging quota or inserting again', async () => {
        const signed = await createSignedAction(
            'create_post',
            { content: 'Already accepted' },
            testDid,
            testHandle,
        );

        vi.mocked(db.query.users.findFirst).mockResolvedValue({
            id: 'uuid-123',
            did: testDid,
            handle: testHandle,
            publicKey: userPublicKeyBase64,
        } as never);
        vi.mocked(db.select).mockReturnValue({
            from: vi.fn(() => ({
                where: vi.fn(() => ({
                    limit: vi.fn().mockResolvedValue([{ actionId: 'already-stored' }]),
                })),
            })),
        } as never);

        const result = await verifyUserAction(signed);

        expect(result).toEqual({ valid: false, error: 'REPLAYED_NONCE' });
        expect(mockIsRateLimited).not.toHaveBeenCalled();
        expect(db.insert).not.toHaveBeenCalled();
    });
});
