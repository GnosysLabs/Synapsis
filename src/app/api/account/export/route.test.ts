import {
    createHash,
    createSign,
    createVerify,
    generateKeyPairSync,
    randomBytes,
    randomUUID,
} from 'node:crypto';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateDID } from '@/lib/crypto/did-key';
import { canonicalize } from '@/lib/crypto/user-signing';
import { encryptPrivateKey, serializeEncryptedKey } from '@/lib/crypto/private-key';
import { encryptionKeyIdFromPublicKey } from '@/lib/e2ee/bundle-proof';
import {
    E2EE_CIPHER_SUITE,
    E2EE_KEY_BUNDLE_ACTION,
    E2EE_PROTOCOL,
} from '@/lib/e2ee/protocol';

const mocks = vi.hoisted(() => ({
    tables: {
        users: { table: 'users' },
        posts: { table: 'posts' },
        media: { table: 'media' },
        follows: { table: 'follows' },
        remoteFollows: { table: 'remoteFollows' },
        chatConversations: { table: 'chatConversations' },
        chatMessages: { table: 'chatMessages' },
        e2eeKeyBundles: { table: 'e2eeKeyBundles' },
        e2eeMessageReceipts: { table: 'e2eeMessageReceipts' },
    },
    requireAuth: vi.fn(),
    verifyPassword: vi.fn(),
    hashPassword: vi.fn(),
    createSession: vi.fn(),
    findPosts: vi.fn(),
    findFollows: vi.fn(),
    findRemoteFollows: vi.fn(),
    findConversations: vi.fn(),
    findE2EEKeyBundle: vi.fn(),
    findUsers: vi.fn(),
    findNodes: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
    insertedRows: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
    safeFederationRequest: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
    requireAuth: mocks.requireAuth,
    verifyPassword: mocks.verifyPassword,
    hashPassword: mocks.hashPassword,
    createSession: mocks.createSession,
}));
vi.mock('@/db', () => ({
    ...mocks.tables,
    db: {
        insert: mocks.insert,
        update: mocks.update,
        transaction: mocks.transaction,
        query: {
            users: { findFirst: mocks.findUsers },
            nodes: { findFirst: mocks.findNodes },
            posts: { findMany: mocks.findPosts },
            follows: { findMany: mocks.findFollows },
            remoteFollows: { findMany: mocks.findRemoteFollows },
            chatConversations: { findMany: mocks.findConversations },
            e2eeKeyBundles: { findFirst: mocks.findE2EEKeyBundle },
        },
    },
}));
vi.mock('drizzle-orm', async (importOriginal) => ({
    ...await importOriginal<typeof import('drizzle-orm')>(),
    eq: vi.fn(() => ({})),
}));
vi.mock('@/lib/federation/handles', () => ({ upsertHandleEntries: vi.fn() }));
vi.mock('@/lib/swarm/safe-federation-http', () => ({
    safeFederationRequest: mocks.safeFederationRequest,
}));

import { POST } from './route';
import { POST as importAccount } from '../import/route';

interface ExportResponseBody {
    export: {
        manifest: {
            version: '1.1';
            did: string;
            handle: string;
            sourceNode: string;
            exportedAt: string;
            expiresAt: string;
            publicKey: string;
            privateKeyEncrypted: string;
            payloadDigestAlgorithm: 'sha256';
            payloadDigest: string;
            signature: string;
        };
        profile: unknown;
        posts: unknown[];
        following: unknown[];
        dms: unknown[];
        e2eeKeyBundle: unknown | null;
    };
}

describe('account export manifest integrity', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.insertedRows.length = 0;
        vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'export.synapsis.social');
        mocks.verifyPassword.mockResolvedValue(true);
        mocks.hashPassword.mockResolvedValue('imported-password-hash');
        mocks.createSession.mockResolvedValue('imported-session-token');
        mocks.findPosts.mockResolvedValue([]);
        mocks.findFollows.mockResolvedValue([]);
        mocks.findRemoteFollows.mockResolvedValue([]);
        mocks.findConversations.mockResolvedValue([]);
        mocks.findE2EEKeyBundle.mockResolvedValue(undefined);
        mocks.findUsers.mockResolvedValue(undefined);
        mocks.findNodes.mockResolvedValue(undefined);
        mocks.safeFederationRequest.mockResolvedValue({ status: 204 });
        mocks.update.mockImplementation(() => ({
            set: () => ({
                where: () => Promise.resolve(),
            }),
        }));
        mocks.insert.mockImplementation((table: unknown) => ({
            values: (values: Record<string, unknown>) => {
                mocks.insertedRows.push({ table, values });
                const returnedRows = table === mocks.tables.users
                    ? [{ id: 'imported-user-1', ...values }]
                    : table === mocks.tables.chatConversations
                        ? [{ id: 'imported-conversation-1', ...values }]
                        : [];
                return Object.assign(Promise.resolve(), {
                    returning: vi.fn(async () => returnedRows),
                    onConflictDoNothing: vi.fn(async () => undefined),
                });
            },
        }));
        mocks.transaction.mockImplementation(async (
            callback: (tx: { insert: typeof mocks.insert }) => Promise<unknown>,
        ) => callback({ insert: mocks.insert }));
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('decrypts the stored key to sign v1.1 while exporting its encrypted blob unchanged', async () => {
        const password = 'correct horse battery staple';
        const { privateKey, publicKey } = generateKeyPairSync('ec', {
            namedCurve: 'P-256',
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            publicKeyEncoding: { type: 'spki', format: 'pem' },
        });
        const storedPrivateKey = serializeEncryptedKey(encryptPrivateKey(privateKey, password));
        const ownerDid = generateDID(publicKey);
        const peerDid = 'did:synapsis:export-peer';
        const envelopeCreatedAt = Math.floor(Date.now() / 1_000) * 1_000 + 537;
        const storedCreatedAt = new Date(Math.floor(envelopeCreatedAt / 1_000) * 1_000);
        const messageId = randomUUID();
        const senderKeyId = `k1_${randomBytes(12).toString('base64url')}`;
        const recipientKeyId = `k1_${randomBytes(12).toString('base64url')}`;
        const envelope = {
            protocol: E2EE_PROTOCOL,
            cipherSuite: E2EE_CIPHER_SUITE,
            messageId,
            conversationId: `dm1_${randomBytes(12).toString('base64url')}`,
            senderDid: ownerDid,
            senderHandle: 'alice',
            recipientDid: peerDid,
            recipientHandle: 'bob',
            createdAt: envelopeCreatedAt,
            senderKeyId,
            senderKeyVersion: 1,
            recipientKeyId,
            recipientKeyVersion: 1,
            nonce: randomBytes(24).toString('base64url'),
            ciphertext: randomBytes(17).toString('base64url'),
            keyCommitment: randomBytes(32).toString('base64url'),
            keyEnvelopes: [
                {
                    did: ownerDid,
                    keyId: senderKeyId,
                    keyVersion: 1,
                    sealedKey: randomBytes(112).toString('base64url'),
                },
                {
                    did: peerDid,
                    keyId: recipientKeyId,
                    keyVersion: 1,
                    sealedKey: randomBytes(112).toString('base64url'),
                },
            ],
        };
        const actionNonce = randomBytes(16).toString('base64url');
        const actionPayload = {
            action: 'chat_e2ee',
            data: envelope,
            did: ownerDid,
            handle: 'alice',
            nonce: actionNonce,
            ts: envelopeCreatedAt,
        };
        const actionSigner = createSign('sha256');
        actionSigner.update(canonicalize(actionPayload));
        const actionSignature = actionSigner.sign({
            key: privateKey,
            dsaEncoding: 'ieee-p1363',
        }).toString('base64url');

        const encryptionPublicKey = randomBytes(32).toString('base64url');
        const continuityKeyId = await encryptionKeyIdFromPublicKey(encryptionPublicKey);
        if (!continuityKeyId) throw new Error('Could not derive test encryption key ID');
        const continuityCreatedAt = Date.now();
        const continuityBundle = {
            protocol: E2EE_PROTOCOL,
            keyId: continuityKeyId,
            version: 1,
            publicKey: encryptionPublicKey,
            createdAt: continuityCreatedAt,
            recoveryCommitment: randomBytes(32).toString('base64url'),
        };
        const continuityProofPayload = {
            action: E2EE_KEY_BUNDLE_ACTION,
            data: continuityBundle,
            did: ownerDid,
            handle: 'alice',
            nonce: randomBytes(16).toString('base64url'),
            ts: continuityCreatedAt,
        };
        const continuitySigner = createSign('sha256');
        continuitySigner.update(canonicalize(continuityProofPayload));
        const continuityProof = {
            ...continuityProofPayload,
            sig: continuitySigner.sign({
                key: privateKey,
                dsaEncoding: 'ieee-p1363',
            }).toString('base64url'),
        };

        mocks.findConversations.mockResolvedValue([{
            id: 'conversation-1',
            type: 'direct',
            participant2Handle: 'bob',
            lastMessageAt: storedCreatedAt,
            lastMessagePreview: 'Encrypted message',
            encryptionMode: 'e2ee',
            e2eeActivatedAt: storedCreatedAt,
            messages: [{
                senderHandle: 'alice',
                senderDisplayName: 'Alice',
                senderAvatarUrl: null,
                senderNodeDomain: null,
                senderDid: ownerDid,
                content: null,
                protocolVersion: 1,
                clientMessageId: messageId,
                encryptedEnvelope: JSON.stringify(envelope),
                e2eeSignature: actionSignature,
                e2eeActionNonce: actionNonce,
                e2eeActionTs: envelopeCreatedAt,
                deliveredAt: null,
                readAt: null,
                createdAt: storedCreatedAt,
            }],
        }]);
        mocks.requireAuth.mockResolvedValue({
            id: 'user-1',
            did: ownerDid,
            handle: 'alice',
            displayName: 'Alice',
            bio: null,
            avatarUrl: null,
            headerUrl: null,
            passwordHash: 'password-hash',
            publicKey,
            privateKeyEncrypted: storedPrivateKey,
            movedTo: null,
        });
        mocks.findE2EEKeyBundle.mockResolvedValue({
            did: ownerDid,
            keyId: continuityKeyId,
            keyVersion: 1,
            publicKey: encryptionPublicKey,
            proofAction: JSON.stringify(continuityProof),
        });

        const response = await POST(new NextRequest('https://export.synapsis.social/api/account/export', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password }),
        }));
        const body = await response.json() as ExportResponseBody;

        expect(response.status).toBe(200);
        expect(body.export.manifest.version).toBe('1.1');
        expect(body.export.manifest.privateKeyEncrypted).toBe(storedPrivateKey);
        expect(body.export.manifest).not.toHaveProperty('salt');
        expect(body.export.manifest).not.toHaveProperty('iv');
        expect(body.export.e2eeKeyBundle).toEqual({
            did: ownerDid,
            keyId: continuityKeyId,
            keyVersion: 1,
            publicKey: encryptionPublicKey,
            proofAction: continuityProof,
        });

        const { signature, ...manifestData } = body.export.manifest;
        const verifier = createVerify('sha256');
        verifier.update(canonicalize(manifestData));
        expect(verifier.verify(publicKey, signature, 'base64')).toBe(true);

        const payload = {
            profile: body.export.profile,
            posts: body.export.posts,
            following: body.export.following,
            dms: body.export.dms,
            e2eeKeyBundle: body.export.e2eeKeyBundle,
        };
        expect(body.export.manifest.payloadDigest).toBe(
            createHash('sha256').update(canonicalize(payload)).digest('hex'),
        );

        // The exported message carries millisecond-authenticated envelope
        // time while its DB timestamp is second-precision. A fresh importer
        // must accept the round-trip and preserve account login plus the
        // signed public continuity anchor (but never a PIN vault).
        const importResponse = await importAccount(new NextRequest('https://new.example/api/account/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                exportData: body.export,
                password,
                destinationEmail: '  Alice@New.Example  ',
                newHandle: 'alice_new',
                acceptedCompliance: true,
            }),
        }));
        expect(importResponse.status).toBe(200);
        await expect(importResponse.json()).resolves.toMatchObject({
            success: true,
            stats: { dmsImported: 1 },
            warnings: expect.arrayContaining([
                expect.stringContaining('decryption key is not portable yet'),
            ]),
        });
        expect(mocks.hashPassword).toHaveBeenCalledWith(password);

        const importedUser = mocks.insertedRows.find(({ table }) => table === mocks.tables.users);
        expect(importedUser?.values).toMatchObject({
            did: ownerDid,
            email: 'alice@new.example',
            passwordHash: 'imported-password-hash',
            privateKeyEncrypted: storedPrivateKey,
        });
        expect(mocks.createSession).toHaveBeenCalledOnce();
        expect(mocks.createSession).toHaveBeenCalledWith('imported-user-1');
        const importedContinuity = mocks.insertedRows.find(
            ({ table }) => table === mocks.tables.e2eeKeyBundles,
        );
        expect(importedContinuity?.values).toMatchObject({
            userId: 'imported-user-1',
            did: ownerDid,
            keyId: continuityKeyId,
            keyVersion: 1,
            publicKey: encryptionPublicKey,
        });
        expect(JSON.parse(String(importedContinuity?.values.proofAction))).toEqual(continuityProof);
        expect(importedContinuity?.values).not.toHaveProperty('ciphertext');
        expect(importedContinuity?.values).not.toHaveProperty('pinVerifierMac');
        expect(mocks.safeFederationRequest).toHaveBeenCalledWith(
            'https://export.synapsis.social/api/account/moved',
            expect.objectContaining({ method: 'POST', timeoutMs: 5_000 }),
        );

        mocks.findUsers
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce({ id: 'existing-email-user' });
        const duplicateEmailResponse = await importAccount(new NextRequest('https://new.example/api/account/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                exportData: body.export,
                password,
                destinationEmail: 'alice@new.example',
                newHandle: 'alice_other',
                acceptedCompliance: true,
            }),
        }));
        expect(duplicateEmailResponse.status).toBe(409);
        await expect(duplicateEmailResponse.json()).resolves.toMatchObject({
            error: 'Email is already registered on this node',
        });
        expect(mocks.createSession).toHaveBeenCalledOnce();

        mocks.findUsers.mockResolvedValue(undefined);
        mocks.createSession.mockRejectedValueOnce(new Error('session store unavailable'));
        const sessionFailureResponse = await importAccount(new NextRequest('https://new.example/api/account/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                exportData: body.export,
                password,
                destinationEmail: 'alice-session-fallback@new.example',
                newHandle: 'alice_retry',
                acceptedCompliance: true,
            }),
        }));
        expect(sessionFailureResponse.status).toBe(200);
        await expect(sessionFailureResponse.json()).resolves.toMatchObject({
            success: true,
            warnings: expect.arrayContaining([
                expect.stringContaining('automatic sign-in failed'),
            ]),
        });
        expect(mocks.createSession).toHaveBeenCalledTimes(2);
    });
});
