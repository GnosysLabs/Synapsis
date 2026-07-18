import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const users = { id: 'users.id', followersCount: 'users.followersCount' };
    const follows = Symbol('follows');
    const returning = vi.fn();
    const insertValues = vi.fn(() => ({ returning }));
    const insert = vi.fn(() => ({ values: insertValues }));
    const where = vi.fn();
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const tx = { insert, update };

    return {
        users,
        follows,
        returning,
        insertValues,
        insert,
        where,
        set,
        update,
        tx,
        findFirst: vi.fn(),
        findMany: vi.fn(),
        transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
        upsertHandleEntries: vi.fn(),
    };
});

vi.mock('@/db', () => ({
    db: {
        query: {
            users: {
                findFirst: mocks.findFirst,
                findMany: mocks.findMany,
            },
            swarmAccountTombstones: { findFirst: vi.fn().mockResolvedValue(undefined) },
        },
        transaction: mocks.transaction,
    },
    users: mocks.users,
    follows: mocks.follows,
    sessions: {},
}));

vi.mock('drizzle-orm', () => ({
    eq: vi.fn(),
    inArray: vi.fn(() => 'admin ids'),
    sql: vi.fn(() => 'increment followers'),
}));

vi.mock('bcryptjs', () => ({
    default: {
        hash: vi.fn(async () => 'password hash'),
        compare: vi.fn(),
    },
}));

vi.mock('@/lib/crypto/keys', () => ({
    generateKeyPair: vi.fn(async () => ({ publicKey: 'public key', privateKey: 'private key' })),
}));

vi.mock('@/lib/crypto/did-key', () => ({
    didKeyMatchesPublicKey: vi.fn(),
    generateDID: vi.fn(() => 'did:key:new-user'),
}));

vi.mock('@/lib/crypto/private-key', () => ({
    encryptPrivateKey: vi.fn(() => ({ encrypted: 'encrypted', salt: 'salt', iv: 'iv' })),
    serializeEncryptedKey: vi.fn(() => 'serialized private key'),
    isEncryptedPrivateKeyStored: vi.fn(),
}));

vi.mock('@/lib/federation/handles', () => ({
    upsertHandleEntries: mocks.upsertHandleEntries,
}));

import { registerUser } from './index';

describe('registerUser', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('ADMIN_EMAILS', 'admin@example.com, second-admin@example.com');
        vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'example.social');
        mocks.findFirst.mockResolvedValue(undefined);
    });

    it('atomically follows every existing server admin for a new account', async () => {
        const admins = [
            { id: 'admin-1', email: 'admin@example.com', isSuspended: false },
            { id: 'admin-2', email: 'second-admin@example.com', isSuspended: false },
        ];
        const createdUser = { id: 'user-1', handle: 'newuser', did: 'did:key:new-user' };
        mocks.findMany.mockResolvedValue(admins);
        mocks.returning.mockResolvedValue([createdUser]);

        await registerUser('NewUser', 'new@example.com', 'password123');

        expect(mocks.transaction).toHaveBeenCalledOnce();
        expect(mocks.insertValues).toHaveBeenNthCalledWith(1, expect.objectContaining({
            handle: 'newuser',
            followingCount: 2,
        }));
        expect(mocks.insertValues).toHaveBeenNthCalledWith(2, [
            { followerId: 'user-1', followingId: 'admin-1' },
            { followerId: 'user-1', followingId: 'admin-2' },
        ]);
        expect(mocks.set).toHaveBeenCalledWith({ followersCount: 'increment followers' });
        expect(mocks.upsertHandleEntries).toHaveBeenCalledOnce();
    });

    it('does not follow suspended admins', async () => {
        mocks.findMany.mockResolvedValue([
            { id: 'admin-1', email: 'admin@example.com', isSuspended: true },
        ]);
        mocks.returning.mockResolvedValue([{ id: 'user-1', handle: 'newuser', did: 'did:key:new-user' }]);

        await registerUser('newuser', 'new@example.com', 'password123');

        expect(mocks.insertValues).toHaveBeenCalledOnce();
        expect(mocks.insertValues).toHaveBeenCalledWith(expect.objectContaining({ followingCount: 0 }));
        expect(mocks.update).not.toHaveBeenCalled();
    });
});
