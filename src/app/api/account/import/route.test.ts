import { generateKeyPairSync, createHash, createSign, randomBytes, randomUUID } from 'node:crypto';

import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { canonicalize } from '@/lib/crypto/user-signing';
import { generateDID } from '@/lib/crypto/did-key';
import { encryptPrivateKey, serializeEncryptedKey } from '@/lib/crypto/private-key';
import { encryptionKeyIdFromPublicKey } from '@/lib/e2ee/bundle-proof';
import {
    E2EE_CIPHER_SUITE,
    E2EE_KEY_BUNDLE_ACTION,
    E2EE_PROTOCOL,
} from '@/lib/e2ee/protocol';
import { POST } from './route';

const peerDid = 'did:synapsis:account-import-peer';
const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const ownerDid = generateDID(publicKey);
const storedPrivateKey = serializeEncryptedKey(encryptPrivateKey(privateKey, 'correct-password'));

function basePayload(dms: unknown[]) {
    return {
        profile: {
            displayName: 'Alice',
            bio: null,
            avatarUrl: null,
            headerUrl: null,
        },
        posts: [],
        following: [],
        dms,
        bots: [],
    };
}

function signedExport(payload: ReturnType<typeof basePayload>, integrityProtected = true) {
    const manifestData = {
        version: '1.0' as const,
        did: ownerDid,
        handle: 'alice',
        sourceNode: 'old.synapsis.social',
        exportedAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        publicKey,
        privateKeyEncrypted: 'AA==',
        salt: randomBytes(32).toString('base64'),
        iv: randomBytes(16).toString('base64'),
        ...(integrityProtected ? {
            payloadDigestAlgorithm: 'sha256' as const,
            payloadDigest: createHash('sha256').update(canonicalize(payload)).digest('hex'),
        } : {}),
    };
    const signer = createSign('sha256');
    signer.update(JSON.stringify(manifestData));

    return {
        manifest: {
            ...manifestData,
            signature: signer.sign(privateKey, 'base64'),
        },
        ...payload,
    };
}

function signedV11Export(
    payload: ReturnType<typeof basePayload>,
    options: {
        did?: string;
        sourceNode?: string;
        e2eeKeyBundle?: unknown;
    } = {},
) {
    const signedPayload = {
        ...payload,
        e2eeKeyBundle: options.e2eeKeyBundle ?? null,
    };
    const manifestData = {
        version: '1.1' as const,
        did: options.did ?? ownerDid,
        handle: 'alice',
        sourceNode: options.sourceNode ?? 'old.synapsis.social',
        exportedAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        publicKey,
        privateKeyEncrypted: storedPrivateKey,
        payloadDigestAlgorithm: 'sha256' as const,
        payloadDigest: createHash('sha256').update(canonicalize(signedPayload)).digest('hex'),
    };
    const signer = createSign('sha256');
    signer.update(canonicalize(manifestData));

    return {
        manifest: {
            ...manifestData,
            signature: signer.sign(privateKey, 'base64'),
        },
        ...signedPayload,
    };
}

async function continuityAnchor() {
    const encryptionPublicKey = randomBytes(32).toString('base64url');
    const keyId = await encryptionKeyIdFromPublicKey(encryptionPublicKey);
    if (!keyId) throw new Error('Could not derive test encryption key ID');

    const createdAt = Date.now();
    const bundle = {
        protocol: E2EE_PROTOCOL,
        keyId,
        version: 1,
        publicKey: encryptionPublicKey,
        createdAt,
        recoveryCommitment: randomBytes(32).toString('base64url'),
    };
    const proofPayload = {
        action: E2EE_KEY_BUNDLE_ACTION,
        data: bundle,
        did: ownerDid,
        handle: 'alice',
        nonce: randomBytes(16).toString('base64url'),
        ts: createdAt,
    };
    const proofSigner = createSign('sha256');
    proofSigner.update(canonicalize(proofPayload));

    return {
        did: ownerDid,
        keyId,
        keyVersion: 1,
        publicKey: encryptionPublicKey,
        proofAction: {
            ...proofPayload,
            sig: proofSigner.sign({
                key: privateKey,
                dsaEncoding: 'ieee-p1363',
            }).toString('base64url'),
        },
    };
}

async function importResponse(
    exportData: unknown,
    requestOverrides: Record<string, unknown> = {},
) {
    return POST(new NextRequest('http://localhost/api/account/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            exportData,
            password: 'wrong-on-purpose',
            destinationEmail: 'alice@new.example',
            newHandle: 'alice_new',
            acceptedCompliance: true,
            ...requestOverrides,
        }),
    }));
}

function commonMessage(createdAt: string) {
    return {
        senderHandle: 'alice',
        senderDisplayName: 'Alice',
        senderAvatarUrl: null,
        senderNodeDomain: null,
        senderDid: ownerDid,
        deliveredAt: null,
        readAt: null,
        createdAt,
    };
}

function modernConversation(messages: unknown[], overrides: Record<string, unknown> = {}) {
    return {
        id: randomUUID(),
        type: 'direct',
        participant2Handle: 'bob',
        lastMessageAt: null,
        lastMessagePreview: null,
        encryptionMode: 'legacy',
        e2eeActivatedAt: null,
        messages,
        ...overrides,
    };
}

function encryptedMessage(createdAtMs: number) {
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
        createdAt: createdAtMs,
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
        ts: createdAtMs,
    };
    const actionSigner = createSign('sha256');
    actionSigner.update(canonicalize(actionPayload));

    return {
        // SQLite timestamp columns retain seconds, while the authenticated
        // envelope retains the original millisecond value.
        ...commonMessage(new Date(Math.floor(createdAtMs / 1_000) * 1_000).toISOString()),
        content: null,
        protocolVersion: 1,
        clientMessageId: messageId,
        encryptedEnvelope: JSON.stringify(envelope),
        e2eeSignature: actionSigner.sign({
            key: privateKey,
            dsaEncoding: 'ieee-p1363',
        }).toString('base64url'),
        e2eeActionNonce: actionNonce,
        e2eeActionTs: createdAtMs,
    };
}

describe('account import DM integrity', () => {
    it('requires a valid destination email before importing', async () => {
        const response = await importResponse(
            signedV11Export(basePayload([])),
            { destinationEmail: 'not-an-email' },
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            error: 'Enter a valid destination email address',
        });
    });

    it('accepts a v1.1 export with no E2EE continuity anchor', async () => {
        const response = await importResponse(signedV11Export(basePayload([])));

        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toMatchObject({ error: 'Invalid password' });
    });

    it('accepts a valid account-signed E2EE continuity anchor', async () => {
        const anchor = await continuityAnchor();
        const response = await importResponse(signedV11Export(basePayload([]), {
            e2eeKeyBundle: anchor,
        }));

        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toMatchObject({ error: 'Invalid password' });
    });

    it('rejects a continuity anchor with a forged proof signature', async () => {
        const anchor = await continuityAnchor();
        anchor.proofAction.sig = randomBytes(64).toString('base64url');
        const response = await importResponse(signedV11Export(basePayload([]), {
            e2eeKeyBundle: anchor,
        }));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            error: expect.stringContaining('continuity anchor signature is invalid'),
        });
    });

    it('rejects continuity row fields that do not match the signed bundle', async () => {
        const anchor = await continuityAnchor();
        anchor.keyVersion = 2;
        const response = await importResponse(signedV11Export(basePayload([]), {
            e2eeKeyBundle: anchor,
        }));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            error: expect.stringContaining('does not match its signed proof'),
        });
    });

    it('rejects a self-certifying DID claimed by a different signing key', async () => {
        const otherKeys = generateKeyPairSync('ec', {
            namedCurve: 'P-256',
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            publicKeyEncoding: { type: 'spki', format: 'pem' },
        });
        const squattedDid = generateDID(otherKeys.publicKey);
        const response = await importResponse(signedV11Export(basePayload([]), {
            did: squattedDid,
        }));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            error: 'Export identity must be a self-certifying did:key that matches its signing key',
        });
    });

    it('rejects legacy identity methods that are not self-certifying', async () => {
        const response = await importResponse(signedV11Export(basePayload([]), {
            did: 'did:synapsis:legacy-account',
        }));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            error: 'Export identity must be a self-certifying did:key that matches its signing key',
        });
    });

    it.each([
        '127.0.0.1',
        'localhost:43821',
        '10.0.0.8',
        'https://old.synapsis.social',
        'old.synapsis.social/api/account/moved',
        'user@old.synapsis.social',
    ])('rejects unsafe migration source node %s', async (sourceNode) => {
        const response = await importResponse(signedV11Export(basePayload([]), {
            sourceNode,
        }));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            error: 'Export source node is unsafe or invalid',
        });
    });

    it('rejects edits to any signed v1.1 export payload field', async () => {
        const exportData = signedV11Export(basePayload([]));
        exportData.profile.displayName = 'Mallory';

        const response = await importResponse(exportData);

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            error: 'Export payload integrity check failed',
        });
    });

    it('also verifies the digest when a legacy v1.0 manifest carries one', async () => {
        const exportData = signedExport(basePayload([]));
        exportData.profile.displayName = 'Mallory';

        const response = await importResponse(exportData);

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            error: 'Export payload integrity check failed',
        });
    });

    it('rejects unknown protocol versions instead of treating them as plaintext', async () => {
        const createdAt = new Date().toISOString();
        const unknownMessage = {
            ...commonMessage(createdAt),
            content: 'must not be imported',
            protocolVersion: 2,
            clientMessageId: null,
            encryptedEnvelope: null,
            e2eeSignature: null,
            e2eeActionNonce: null,
            e2eeActionTs: null,
        };
        const response = await importResponse(signedV11Export(basePayload([
            modernConversation([unknownMessage]),
        ])));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            error: expect.stringContaining('Unsupported DM protocol version'),
        });
    });

    it('rejects plaintext at or after a conversation E2EE cutover', async () => {
        const cutoverMs = Math.floor(Date.now() / 1_000) * 1_000 + 789;
        const cutover = new Date(cutoverMs);
        const legacyMessage = {
            ...commonMessage(new Date(Math.floor(cutoverMs / 1_000) * 1_000).toISOString()),
            content: 'late plaintext',
            protocolVersion: 0,
            clientMessageId: null,
            encryptedEnvelope: null,
            e2eeSignature: null,
            e2eeActionNonce: null,
            e2eeActionTs: null,
        };
        const response = await importResponse(signedV11Export(basePayload([
            modernConversation([legacyMessage], {
                encryptionMode: 'e2ee',
                e2eeActivatedAt: cutover.toISOString(),
            }),
        ])));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            error: expect.stringContaining('plaintext at or after its E2EE cutover'),
        });
    });

    it('allows legacy plaintext from the second before the E2EE cutover', async () => {
        const cutoverMs = Math.floor(Date.now() / 1_000) * 1_000 + 789;
        const legacyMessage = {
            ...commonMessage(new Date(Math.floor(cutoverMs / 1_000) * 1_000 - 1_000).toISOString()),
            content: 'plaintext before cutover',
            protocolVersion: 0,
            clientMessageId: null,
            encryptedEnvelope: null,
            e2eeSignature: null,
            e2eeActionNonce: null,
            e2eeActionTs: null,
        };
        const response = await importResponse(signedV11Export(basePayload([
            modernConversation([legacyMessage], {
                encryptionMode: 'e2ee',
                e2eeActivatedAt: new Date(cutoverMs).toISOString(),
            }),
        ])));

        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toMatchObject({ error: 'Invalid password' });
    });

    it('strictly validates an encrypted envelope and its stored signature metadata', async () => {
        const createdAt = Math.floor(Date.now() / 1_000) * 1_000 + 537;
        const validMessage = encryptedMessage(createdAt);
        const validResponse = await importResponse(signedV11Export(basePayload([
            modernConversation([validMessage], {
                encryptionMode: 'e2ee',
                e2eeActivatedAt: new Date(createdAt).toISOString(),
            }),
        ])));
        expect(validResponse.status).toBe(401);

        const invalidMessage = { ...validMessage, senderHandle: 'mallory' };
        const invalidResponse = await importResponse(signedV11Export(basePayload([
            modernConversation([invalidMessage], {
                encryptionMode: 'e2ee',
                e2eeActivatedAt: new Date(createdAt).toISOString(),
            }),
        ])));
        expect(invalidResponse.status).toBe(400);
        await expect(invalidResponse.json()).resolves.toMatchObject({
            error: expect.stringContaining('sender handle does not match'),
        });

        const invalidSignature = {
            ...validMessage,
            e2eeSignature: randomBytes(64).toString('base64url'),
        };
        const invalidSignatureResponse = await importResponse(signedV11Export(basePayload([
            modernConversation([invalidSignature], {
                encryptionMode: 'e2ee',
                e2eeActivatedAt: new Date(createdAt).toISOString(),
            }),
        ])));
        expect(invalidSignatureResponse.status).toBe(400);
        await expect(invalidSignatureResponse.json()).resolves.toMatchObject({
            error: expect.stringContaining('signature is invalid'),
        });
    });

    it('rejects digest-less historical exports before importing unauthenticated payloads', async () => {
        const createdAt = new Date().toISOString();
        const historicalMessage = {
            ...commonMessage(createdAt),
            content: 'historical plaintext',
        };
        const historicalConversation = {
            id: randomUUID(),
            type: 'direct',
            participant2Handle: 'bob',
            lastMessageAt: createdAt,
            lastMessagePreview: 'historical plaintext',
            messages: [historicalMessage],
        };
        const historical = await importResponse(signedExport(
            basePayload([historicalConversation]),
            false,
        ));
        expect(historical.status).toBe(400);
        await expect(historical.json()).resolves.toMatchObject({
            error: 'Historical exports without an authenticated payload are not supported. Create a fresh export from your old node.',
        });

        const injectedConversation = {
            ...historicalConversation,
            messages: [{ ...historicalMessage, protocolVersion: 2 }],
        };
        const injected = await importResponse(signedExport(
            basePayload([injectedConversation]),
            false,
        ));
        expect(injected.status).toBe(400);
        await expect(injected.json()).resolves.toMatchObject({
            error: 'Historical exports without an authenticated payload are not supported. Create a fresh export from your old node.',
        });
    });
});
