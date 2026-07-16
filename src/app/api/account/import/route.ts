/**
 * Account Import API
 * 
 * Imports an account from another Synapsis node using the export package.
 * Creates the user with the same DID and migrates all data.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, users, posts, media, follows, remoteFollows, chatConversations, chatMessages, e2eeKeyBundles, e2eeMessageReceipts } from '@/db';
import { eq, sql } from 'drizzle-orm';
import * as crypto from 'crypto';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { upsertHandleEntries } from '@/lib/federation/handles';
import { canonicalize, verifySignedActionSignature } from '@/lib/crypto/user-signing';
import {
    decryptPrivateKey as decryptStoredPrivateKey,
    deserializeEncryptedKey,
    serializeEncryptedKey,
} from '@/lib/crypto/private-key';
import { didKeyMatchesPublicKey } from '@/lib/crypto/did-key';
import { createSession, hashPassword } from '@/lib/auth';
import {
    E2EE_CHAT_ACTION,
    E2EE_KEY_BUNDLE_ACTION,
    e2eeKeyBundleSchema,
    e2eeMessageEnvelopeSchema,
    signedUserActionSchema,
    validateMessageBindings,
} from '@/lib/e2ee/protocol';
import { encryptionKeyIdFromPublicKey } from '@/lib/e2ee/bundle-proof';
import { getPublicSwarmDomain, normalizeNodeDomain } from '@/lib/swarm/node-domain';
import { safeFederationRequest } from '@/lib/swarm/safe-federation-http';

const isoTimestampSchema = z.iso.datetime({ offset: true });
const didSchema = z.string().min(8).max(2_048).regex(/^did:/);
const base64Schema = z.string().min(1).max(32_768).regex(/^[A-Za-z0-9+/=_-]+$/);
const destinationEmailSchema = z.string().trim().email().max(320);
const serializedEncryptedKeySchema = z.string().min(2).max(65_536).refine((value) => {
    try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        return Object.keys(parsed).length === 3
            && typeof parsed.encrypted === 'string' && base64Schema.safeParse(parsed.encrypted).success
            && typeof parsed.salt === 'string' && base64Schema.max(256).safeParse(parsed.salt).success
            && typeof parsed.iv === 'string' && base64Schema.max(256).safeParse(parsed.iv).success;
    } catch {
        return false;
    }
}, { message: 'Invalid encrypted private key' });

// The property order of the 1.0 schema intentionally matches the historical
// exporter because those manifests were signed with JSON.stringify().
const importManifestV10Schema = z.strictObject({
    version: z.literal('1.0'),
    did: didSchema,
    handle: z.string().min(1).max(320),
    sourceNode: z.string().min(1).max(320),
    exportedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema.optional(),
    publicKey: z.string().min(1).max(16_384),
    privateKeyEncrypted: base64Schema,
    salt: base64Schema.max(256),
    iv: base64Schema.max(256),
    payloadDigestAlgorithm: z.literal('sha256').optional(),
    payloadDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    signature: base64Schema,
}).superRefine((manifest, context) => {
    if ((manifest.payloadDigestAlgorithm === undefined) !== (manifest.payloadDigest === undefined)) {
        context.addIssue({
            code: 'custom',
            message: 'Payload digest fields must be provided together',
        });
    }
});

const importManifestV11Schema = z.strictObject({
    version: z.literal('1.1'),
    did: didSchema,
    handle: z.string().min(1).max(320),
    sourceNode: z.string().min(1).max(320),
    exportedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
    publicKey: z.string().min(1).max(16_384),
    privateKeyEncrypted: serializedEncryptedKeySchema,
    payloadDigestAlgorithm: z.literal('sha256'),
    payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
    signature: base64Schema,
});

const importManifestSchema = z.union([
    importManifestV10Schema,
    importManifestV11Schema,
]);

type ImportManifest = z.infer<typeof importManifestSchema>;

function hasPayloadDigest(manifest: ImportManifest): manifest is ImportManifest & {
    payloadDigestAlgorithm: 'sha256';
    payloadDigest: string;
} {
    return manifest.payloadDigestAlgorithm === 'sha256'
        && typeof manifest.payloadDigest === 'string';
}

interface ImportProfile {
    displayName: string | null;
    bio: string | null;
    avatarUrl: string | null;
    headerUrl: string | null;
}

interface ImportPost {
    id: string;
    content: string;
    createdAt: string;
    replyToApId: string | null;
    media: { filename: string; url: string; altText: string | null; isIPFS?: boolean }[];
}

interface ImportFollowing {
    actorUrl: string;
    handle: string;
    isRemote?: boolean;
    inboxUrl?: string;
    activityId?: string;
}

interface ImportDMConversation {
    id: string;
    type: string;
    participant2Handle: string;
    lastMessageAt: string | null;
    lastMessagePreview: string | null;
    encryptionMode: 'legacy' | 'e2ee';
    e2eeActivatedAt: string | null;
    messages: ImportDMMessage[];
}

interface ImportDMMessage {
    senderHandle: string;
    senderDisplayName: string | null;
    senderAvatarUrl: string | null;
    senderNodeDomain: string | null;
    senderDid: string | null;
    content: string | null;
    protocolVersion: 0 | 1;
    clientMessageId: string | null;
    encryptedEnvelope: string | null;
    e2eeSignature: string | null;
    e2eeActionNonce: string | null;
    e2eeActionTs: number | null;
    deliveredAt: string | null;
    readAt: string | null;
    createdAt: string;
}

const dmMessageCommonSchema = {
    senderHandle: z.string().min(1).max(640),
    senderDisplayName: z.string().max(1_000).nullable(),
    senderAvatarUrl: z.string().max(16_384).nullable(),
    senderNodeDomain: z.string().max(320).nullable(),
    deliveredAt: isoTimestampSchema.nullable(),
    readAt: isoTimestampSchema.nullable(),
    createdAt: isoTimestampSchema,
};

const historicalLegacyDMMessageSchema = z.strictObject({
    ...dmMessageCommonSchema,
    senderDid: didSchema.nullable(),
    content: z.string().max(100_000).nullable(),
});

const legacyDMMessageSchema = z.strictObject({
    ...dmMessageCommonSchema,
    senderDid: didSchema.nullable(),
    content: z.string().max(100_000).nullable(),
    protocolVersion: z.literal(0),
    clientMessageId: z.null(),
    encryptedEnvelope: z.null(),
    e2eeSignature: z.null(),
    e2eeActionNonce: z.null(),
    e2eeActionTs: z.null(),
});

const encryptedDMMessageSchema = z.strictObject({
    ...dmMessageCommonSchema,
    senderDid: didSchema,
    content: z.null(),
    protocolVersion: z.literal(1),
    clientMessageId: z.string().uuid(),
    encryptedEnvelope: z.string().min(2).max(32_768),
    e2eeSignature: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/),
    e2eeActionNonce: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
    e2eeActionTs: z.number().int().positive(),
});

const e2eeContinuityAnchorSchema = z.strictObject({
    did: didSchema,
    keyId: z.string().min(12).max(96).regex(/^k1_[A-Za-z0-9_-]+$/),
    keyVersion: z.number().int().positive().max(1_000_000),
    publicKey: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
    proofAction: signedUserActionSchema,
});

interface ImportedE2EEContinuityAnchor {
    did: string;
    keyId: string;
    keyVersion: number;
    publicKey: string;
    proofAction: z.infer<typeof signedUserActionSchema>;
    createdAt: number;
}

const dmConversationCommonSchema = {
    id: z.string().min(1).max(128),
    type: z.string().min(1).max(32),
    participant2Handle: z.string().min(1).max(640),
    lastMessageAt: isoTimestampSchema.nullable(),
    lastMessagePreview: z.string().max(100_000).nullable(),
    messages: z.array(z.unknown()).max(100_000),
};

const dmConversationV10Schema = z.strictObject({
    ...dmConversationCommonSchema,
});

const dmConversationV11Schema = z.strictObject({
    ...dmConversationCommonSchema,
    encryptionMode: z.enum(['legacy', 'e2ee']),
    e2eeActivatedAt: isoTimestampSchema.nullable(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExactDevelopmentLoopbackNode(value: string): boolean {
    const match = value.match(/^(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/);
    if (!match) return false;
    if (!match[1]) return true;
    const port = Number(match[1]);
    return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function validatedSourceNode(value: string): string | null {
    if (value !== value.trim()) return null;
    const normalized = value.toLowerCase();
    if (!normalized || normalizeNodeDomain(normalized) !== normalized) return null;

    if (process.env.NODE_ENV === 'development' && isExactDevelopmentLoopbackNode(normalized)) {
        return normalized;
    }

    const publicDomain = getPublicSwarmDomain(normalized);
    return publicDomain === normalized ? publicDomain : null;
}

function sourceNodeProtocol(sourceNode: string): 'http' | 'https' {
    return process.env.NODE_ENV === 'development'
        && isExactDevelopmentLoopbackNode(sourceNode)
        ? 'http'
        : 'https';
}

async function validateE2EEContinuityAnchor(
    rawAnchor: unknown,
    manifest: ImportManifest,
): Promise<ImportedE2EEContinuityAnchor> {
    const anchor = e2eeContinuityAnchorSchema.parse(rawAnchor);
    const proof = anchor.proofAction;
    const bundle = e2eeKeyBundleSchema.parse(proof.data);

    if (proof.action !== E2EE_KEY_BUNDLE_ACTION
        || proof.did !== manifest.did
        || proof.handle.toLowerCase() !== manifest.handle.toLowerCase()
        || anchor.did !== manifest.did
        || anchor.did !== proof.did
        || anchor.keyId !== bundle.keyId
        || anchor.keyVersion !== bundle.version
        || anchor.publicKey !== bundle.publicKey
        || Math.abs(bundle.createdAt - proof.ts) > 5 * 60 * 1_000) {
        throw new Error('E2EE continuity anchor does not match its signed proof');
    }
    if (Buffer.from(bundle.publicKey, 'base64url').length !== 32
        || Buffer.from(bundle.recoveryCommitment, 'base64url').length !== 32
        || await encryptionKeyIdFromPublicKey(bundle.publicKey) !== bundle.keyId) {
        throw new Error('E2EE continuity anchor key is invalid');
    }
    if (!await verifySignedActionSignature(proof, manifest.publicKey)) {
        throw new Error('E2EE continuity anchor signature is invalid');
    }

    return {
        did: anchor.did,
        keyId: anchor.keyId,
        keyVersion: anchor.keyVersion,
        publicKey: anchor.publicKey,
        proofAction: proof,
        createdAt: bundle.createdAt,
    };
}

function digestImportPayload(exportData: Record<string, unknown>): string {
    const payload = Object.fromEntries(
        Object.entries(exportData).filter(([key]) => key !== 'manifest'),
    );
    return crypto.createHash('sha256').update(canonicalize(payload)).digest('hex');
}

function payloadDigestMatches(expected: string, actual: string): boolean {
    const expectedBytes = Buffer.from(expected, 'hex');
    const actualBytes = Buffer.from(actual, 'hex');
    return expectedBytes.length === actualBytes.length
        && expectedBytes.length === 32
        && crypto.timingSafeEqual(expectedBytes, actualBytes);
}

function sqliteTimestampSecond(timestamp: number): number {
    return Math.floor(timestamp / 1_000);
}

function validateCiphertextSizes(envelope: z.infer<typeof e2eeMessageEnvelopeSchema>): void {
    if (Buffer.from(envelope.nonce, 'base64url').length !== 24
        || Buffer.from(envelope.ciphertext, 'base64url').length < 17
        || Buffer.from(envelope.ciphertext, 'base64url').length > 8_192
        || Buffer.from(envelope.keyCommitment, 'base64url').length !== 32
        || envelope.keyEnvelopes.some((item) => Buffer.from(item.sealedKey, 'base64url').length !== 112)) {
        throw new Error('Encrypted DM has invalid field sizes');
    }
}

async function normalizeEncryptedDMMessage(
    rawMessage: unknown,
    ownerDid: string,
    ownerPublicKey: string,
): Promise<ImportDMMessage> {
    const message = encryptedDMMessageSchema.parse(rawMessage);
    let rawEnvelope: unknown;
    try {
        rawEnvelope = JSON.parse(message.encryptedEnvelope);
    } catch {
        throw new Error('Encrypted DM envelope is not valid JSON');
    }

    const envelope = e2eeMessageEnvelopeSchema.parse(rawEnvelope);
    const storedSenderHandle = message.senderHandle.toLowerCase().replace(/^@/, '');
    const signedSenderHandle = envelope.senderHandle.toLowerCase().replace(/^@/, '');
    if (storedSenderHandle !== signedSenderHandle
        && !storedSenderHandle.startsWith(`${signedSenderHandle}@`)) {
        throw new Error('Encrypted DM sender handle does not match its envelope');
    }
    const signedAction = signedUserActionSchema.parse({
        action: E2EE_CHAT_ACTION,
        data: envelope,
        did: message.senderDid,
        handle: envelope.senderHandle,
        ts: message.e2eeActionTs,
        nonce: message.e2eeActionNonce,
        sig: message.e2eeSignature,
    });
    validateMessageBindings(envelope, signedAction);
    validateCiphertextSizes(envelope);

    // The export carries the imported account's signing key, so messages sent
    // by that account can and must retain a valid original action signature.
    // Incoming peer signatures remain structurally validated here and are
    // verified against resolved peer keys when displayed by the chat client.
    if (envelope.senderDid === ownerDid
        && !await verifySignedActionSignature(signedAction, ownerPublicKey)) {
        throw new Error('Encrypted DM signature is invalid');
    }

    if (message.clientMessageId !== envelope.messageId) {
        throw new Error('Encrypted DM message ID does not match its envelope');
    }
    if (sqliteTimestampSecond(Date.parse(message.createdAt))
        !== sqliteTimestampSecond(envelope.createdAt)) {
        throw new Error('Encrypted DM timestamp does not match its envelope');
    }
    if (envelope.senderDid !== ownerDid && envelope.recipientDid !== ownerDid) {
        throw new Error('Encrypted DM does not include the imported account');
    }
    if (envelope.senderDid === envelope.recipientDid || envelope.keyEnvelopes.length !== 2) {
        throw new Error('Encrypted DM participants are invalid');
    }

    return {
        ...message,
        encryptedEnvelope: JSON.stringify(envelope),
    };
}

function normalizeLegacyDMMessage(
    rawMessage: unknown,
    integrityProtected: boolean,
): ImportDMMessage {
    const message = integrityProtected
        ? legacyDMMessageSchema.parse(rawMessage)
        : historicalLegacyDMMessageSchema.parse(rawMessage);
    return {
        ...message,
        protocolVersion: 0,
        clientMessageId: null,
        encryptedEnvelope: null,
        e2eeSignature: null,
        e2eeActionNonce: null,
        e2eeActionTs: null,
    };
}

async function normalizeImportedDMs(
    rawConversations: unknown[],
    manifest: ImportManifest,
    payloadIntegrityVerified: boolean,
): Promise<ImportDMConversation[]> {
    const integrityProtected = payloadIntegrityVerified;
    return Promise.all(rawConversations.map(async (rawConversation, conversationIndex) => {
        const protectedConversation = integrityProtected
            ? dmConversationV11Schema.parse(rawConversation)
            : null;
        const conversation = protectedConversation
            ?? dmConversationV10Schema.parse(rawConversation);
        const messages: ImportDMMessage[] = [];
        let sawEncrypted = false;

        for (const [messageIndex, rawMessage] of conversation.messages.entries()) {
            const rawVersion = isRecord(rawMessage) ? rawMessage.protocolVersion : undefined;

            try {
                if (!integrityProtected) {
                    // Historical 1.0 exports predate encrypted DM fields. The
                    // strict historical schema rejects injected protocol
                    // markers instead of guessing that they are plaintext.
                    messages.push(normalizeLegacyDMMessage(rawMessage, false));
                } else if (rawVersion === 0) {
                    messages.push(normalizeLegacyDMMessage(rawMessage, true));
                } else if (rawVersion === 1) {
                    messages.push(await normalizeEncryptedDMMessage(
                        rawMessage,
                        manifest.did,
                        manifest.publicKey,
                    ));
                    sawEncrypted = true;
                } else {
                    throw new Error('Unsupported DM protocol version');
                }
            } catch (error) {
                const reason = error instanceof Error ? error.message : 'invalid message';
                throw new Error(`Invalid DM ${conversationIndex + 1}.${messageIndex + 1}: ${reason}`);
            }
        }

        let encryptionMode: 'legacy' | 'e2ee' = 'legacy';
        let activatedAt: number | null = null;
        if (protectedConversation) {
            encryptionMode = protectedConversation.encryptionMode;
            activatedAt = protectedConversation.e2eeActivatedAt
                ? Date.parse(protectedConversation.e2eeActivatedAt)
                : null;
            if (encryptionMode === 'legacy' && activatedAt !== null) {
                throw new Error(`Legacy DM conversation ${conversationIndex + 1} has an E2EE activation time`);
            }
            if (encryptionMode === 'legacy' && sawEncrypted) {
                throw new Error(`Legacy DM conversation ${conversationIndex + 1} contains encrypted messages`);
            }
            if (encryptionMode === 'e2ee' && activatedAt === null) {
                throw new Error(`Encrypted DM conversation ${conversationIndex + 1} has no activation time`);
            }
        }

        if (activatedAt !== null) {
            const legacyAfterCutover = messages.some((message) => (
                message.protocolVersion === 0
                && sqliteTimestampSecond(Date.parse(message.createdAt))
                    >= sqliteTimestampSecond(activatedAt!)
            ));
            if (legacyAfterCutover) {
                throw new Error(`DM conversation ${conversationIndex + 1} contains plaintext at or after its E2EE cutover`);
            }
        }

        return {
            id: conversation.id,
            type: conversation.type,
            participant2Handle: conversation.participant2Handle,
            lastMessageAt: conversation.lastMessageAt,
            lastMessagePreview: conversation.lastMessagePreview,
            encryptionMode,
            e2eeActivatedAt: activatedAt === null ? null : new Date(activatedAt).toISOString(),
            messages,
        };
    }));
}

/**
 * Decrypt the private key using the user's password
 */
function decryptLegacyExportPrivateKey(encrypted: string, password: string, salt: string, iv: string): string {
    const saltBuffer = Buffer.from(salt, 'base64');
    const ivBuffer = Buffer.from(iv, 'base64');
    const encryptedBuffer = Buffer.from(encrypted, 'base64');

    // Separate auth tag (last 16 bytes) from encrypted data
    const authTag = encryptedBuffer.subarray(encryptedBuffer.length - 16);
    const encryptedData = encryptedBuffer.subarray(0, encryptedBuffer.length - 16);

    // Derive key from password
    const key = crypto.pbkdf2Sync(password, saltBuffer, 100000, 32, 'sha256');

    // Decrypt
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, ivBuffer);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedData);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString('utf8');
}

function signingKeyMatchesPublicKey(privateKey: string, publicKey: string): boolean {
    try {
        const derivedPublicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
        const expectedPublicKey = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
        return derivedPublicKey.length === expectedPublicKey.length
            && crypto.timingSafeEqual(derivedPublicKey, expectedPublicKey);
    } catch {
        return false;
    }
}

/**
 * Verify the manifest signature
 */
function verifyManifestSignature(manifest: ImportManifest): boolean {
    try {
        const { signature, ...manifestData } = manifest;
        const data = manifest.version === '1.1'
            ? canonicalize(manifestData)
            : JSON.stringify(manifestData);

        const verify = crypto.createVerify('sha256');
        verify.update(data);

        return verify.verify(manifest.publicKey, signature, 'base64');
    } catch (error) {
        console.error('Signature verification failed:', error);
        return false;
    }
}

export async function POST(req: NextRequest) {
    try {
        const body: unknown = await req.json();
        if (!isRecord(body)) {
            return NextResponse.json({ error: 'Invalid import request' }, { status: 400 });
        }
        const { exportData, password, newHandle, destinationEmail, acceptedCompliance } = body;

        // Validate required fields
        if (!isRecord(exportData)
            || typeof password !== 'string' || password.length === 0
            || typeof newHandle !== 'string' || newHandle.length === 0
            || typeof destinationEmail !== 'string' || destinationEmail.length === 0) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }

        const destinationEmailResult = destinationEmailSchema.safeParse(destinationEmail);
        if (!destinationEmailResult.success) {
            return NextResponse.json({
                error: 'Enter a valid destination email address',
            }, { status: 400 });
        }
        const destinationEmailClean = destinationEmailResult.data.toLowerCase();

        if (acceptedCompliance !== true) {
            return NextResponse.json({
                error: 'You must accept the content compliance agreement'
            }, { status: 400 });
        }

        const manifestResult = importManifestSchema.safeParse(exportData.manifest);
        if (!manifestResult.success) {
            return NextResponse.json({ error: 'Invalid or unsupported export manifest' }, { status: 400 });
        }
        const manifest = manifestResult.data;

        // Check if export has expired
        if (manifest.expiresAt) {
            const expiresAt = new Date(manifest.expiresAt);
            if (expiresAt < new Date()) {
                return NextResponse.json({ 
                    error: 'Export has expired. Please create a new export from your old node.' 
                }, { status: 400 });
            }
        }

        // Verify signature
        if (!verifyManifestSignature(manifest)) {
            return NextResponse.json({ error: 'Invalid export signature' }, { status: 400 });
        }
        if (!didKeyMatchesPublicKey(manifest.did, manifest.publicKey)) {
            return NextResponse.json({
                error: 'Export identity must be a self-certifying did:key that matches its signing key',
            }, { status: 400 });
        }
        const sourceNode = validatedSourceNode(manifest.sourceNode);
        if (!sourceNode) {
            return NextResponse.json({ error: 'Export source node is unsafe or invalid' }, { status: 400 });
        }

        if (!hasPayloadDigest(manifest)) {
            return NextResponse.json({
                error: 'Historical exports without an authenticated payload are not supported. Create a fresh export from your old node.',
            }, { status: 400 });
        }
        const actualDigest = digestImportPayload(exportData);
        if (!payloadDigestMatches(manifest.payloadDigest, actualDigest)) {
            return NextResponse.json({ error: 'Export payload integrity check failed' }, { status: 400 });
        }

        const { profile: rawProfile, posts: rawPosts, following: rawFollowing } = exportData;
        if (!isRecord(rawProfile) || !Array.isArray(rawPosts) || !Array.isArray(rawFollowing)) {
            return NextResponse.json({ error: 'Invalid export payload' }, { status: 400 });
        }
        const supportedPayloadFields = new Set([
            'manifest',
            'profile',
            'posts',
            'following',
            'dms',
            'e2eeKeyBundle',
            // Older exports always included this field. Empty arrays remain
            // importable, but automated accounts themselves are unsupported.
            'bots',
        ]);
        if (Object.keys(exportData).some((field) => !supportedPayloadFields.has(field))) {
            return NextResponse.json({ error: 'Export payload contains unsupported fields' }, { status: 400 });
        }
        const rawDMs = exportData.dms === undefined ? [] : exportData.dms;
        if (!Array.isArray(rawDMs)) {
            return NextResponse.json({ error: 'Invalid export payload' }, { status: 400 });
        }
        const legacyAutomatedAccounts = exportData.bots;
        if (legacyAutomatedAccounts !== undefined
            && (!Array.isArray(legacyAutomatedAccounts) || legacyAutomatedAccounts.length > 0)) {
            return NextResponse.json({ error: 'Export payload contains unsupported account types' }, { status: 400 });
        }
        let importedE2EEKeyBundle: ImportedE2EEContinuityAnchor | null = null;
        if (manifest.version === '1.1' && exportData.e2eeKeyBundle != null) {
            try {
                importedE2EEKeyBundle = await validateE2EEContinuityAnchor(
                    exportData.e2eeKeyBundle,
                    manifest,
                );
            } catch (error) {
                const reason = error instanceof Error ? error.message : 'invalid E2EE continuity anchor';
                return NextResponse.json({ error: `Invalid E2EE continuity anchor: ${reason}` }, { status: 400 });
            }
        }

        let importDMs: ImportDMConversation[];
        try {
            importDMs = await normalizeImportedDMs(rawDMs, manifest, true);
        } catch (error) {
            const reason = error instanceof Error ? error.message : 'invalid direct-message history';
            return NextResponse.json({ error: `Invalid direct-message history: ${reason}` }, { status: 400 });
        }
        const encryptedDMImportWarning = importDMs.some((conversation) => (
            conversation.messages.some((message) => message.protocolVersion === 1)
        ))
            ? 'Encrypted DM records were preserved, but their decryption key is not portable yet. This history cannot be opened on this node.'
            : null;
        const federatedMoveWarning = importedE2EEKeyBundle
            ? 'Federated DM relationships do not automatically follow a home-node move. Peers that cached your old full handle may reject the new handle until signed account-move support is implemented.'
            : null;

        const profile = rawProfile as unknown as ImportProfile;
        const importPosts = rawPosts as ImportPost[];
        const following = rawFollowing as ImportFollowing[];

        // Decrypt private key to verify password is correct
        let privateKey: string;
        let privateKeyEncryptedForStorage: string;
        try {
            if (manifest.version === '1.1') {
                privateKey = decryptStoredPrivateKey(
                    deserializeEncryptedKey(manifest.privateKeyEncrypted),
                    password,
                );
                privateKeyEncryptedForStorage = manifest.privateKeyEncrypted;
            } else {
                privateKey = decryptLegacyExportPrivateKey(
                    manifest.privateKeyEncrypted,
                    password,
                    manifest.salt,
                    manifest.iv,
                );
                privateKeyEncryptedForStorage = serializeEncryptedKey({
                    encrypted: manifest.privateKeyEncrypted,
                    salt: manifest.salt,
                    iv: manifest.iv,
                });
            }
        } catch {
            return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
        }
        if (!signingKeyMatchesPublicKey(privateKey, manifest.publicKey)) {
            return NextResponse.json({ error: 'Export private key does not match its signing key' }, { status: 400 });
        }
        const importedPasswordHash = await hashPassword(password);

        // Check if DID already exists on this node
        const existingDid = await db.query.users.findFirst({
            where: { did: manifest.did },
        });

        if (existingDid) {
            return NextResponse.json({
                error: 'This account has already been imported to this node'
            }, { status: 409 });
        }

        const existingEmail = await db.query.users.findFirst({
            where: { email: destinationEmailClean },
        });

        if (existingEmail) {
            return NextResponse.json({
                error: 'Email is already registered on this node',
            }, { status: 409 });
        }

        // Validate handle format
        const handleClean = newHandle.toLowerCase().replace(/^@/, '').trim();
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(handleClean)) {
            return NextResponse.json({
                error: 'Handle must be 3-20 characters, alphanumeric and underscores only'
            }, { status: 400 });
        }

        // Check if handle is available
        const existingHandle = await db.query.users.findFirst({
            where: { handle: handleClean },
        });

        if (existingHandle) {
            return NextResponse.json({
                error: 'Handle is already taken on this node',
                suggestedHandle: `${handleClean}_${Math.floor(Math.random() * 1000)}`,
            }, { status: 409 });
        }

        const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';
        const oldActorUrl = `${sourceNodeProtocol(sourceNode)}://${sourceNode}/users/${manifest.handle}`;
        const newActorUrl = `https://${nodeDomain}/users/${handleClean}`;

        // The identity and its public continuity anchor are one unit. A key-ID
        // conflict must not leave behind an account that cannot be retried.
        const newUser = await db.transaction(async (tx) => {
            const [createdUser] = await tx.insert(users).values({
                did: manifest.did,
                handle: handleClean,
                email: destinationEmailClean,
                displayName: profile.displayName,
                bio: profile.bio,
                avatarUrl: profile.avatarUrl, // Note: URLs from old node might need re-uploading
                headerUrl: profile.headerUrl,
                publicKey: manifest.publicKey,
                privateKeyEncrypted: privateKeyEncryptedForStorage,
                passwordHash: importedPasswordHash,
                movedFrom: oldActorUrl,
                migratedAt: new Date(),
                postsCount: importPosts.length,
            }).returning();

            if (importedE2EEKeyBundle) {
                await tx.insert(e2eeKeyBundles).values({
                    userId: createdUser.id,
                    did: importedE2EEKeyBundle.did,
                    keyId: importedE2EEKeyBundle.keyId,
                    keyVersion: importedE2EEKeyBundle.keyVersion,
                    publicKey: importedE2EEKeyBundle.publicKey,
                    proofAction: JSON.stringify(importedE2EEKeyBundle.proofAction),
                    createdAt: new Date(importedE2EEKeyBundle.createdAt),
                    updatedAt: new Date(),
                });
            }

            return createdUser;
        });

        // Check if this is an NSFW node and auto-enable NSFW settings
        const node = await db.query.nodes.findFirst({
            where: { domain: nodeDomain },
        });

        if (node?.isNsfw) {
            await db.update(users)
                .set({
                    nsfwEnabled: true,
                    isNsfw: true
                })
                .where(eq(users.id, newUser.id));
        }

        // Import posts
        let importedPosts = 0;
        for (const post of importPosts) {
            try {
                const [newPost] = await db.insert(posts).values({
                    userId: newUser.id,
                    content: post.content,
                    createdAt: new Date(post.createdAt),
                    apId: `https://${nodeDomain}/posts/${uuid()}`,
                    apUrl: `https://${nodeDomain}/posts/${uuid()}`,
                }).returning();

                // Import media references
                // For IPFS media (ipfs://hash), the URL works on any node
                // For legacy S3 media, URL points to old node (may break if old node goes down)
                for (const mediaItem of post.media) {
                    await db.insert(media).values({
                        userId: newUser.id,
                        postId: newPost.id,
                        url: mediaItem.url, // IPFS URLs are portable, S3 URLs are not
                        altText: mediaItem.altText,
                    });
                }

                importedPosts++;
            } catch (error) {
                console.error('Failed to import post:', error);
            }
        }

        // Update handle registry
        await upsertHandleEntries([{
            handle: handleClean,
            did: manifest.did,
            nodeDomain,
            updatedAt: new Date().toISOString(),
        }]);

        // Import following list
        let importedFollowing = 0;
        for (const follow of following) {
            try {
                if (follow.isRemote) {
                    // Remote follow - add to remoteFollows table
                    await db.insert(remoteFollows).values({
                        followerId: newUser.id,
                        targetHandle: follow.handle,
                        targetActorUrl: follow.actorUrl || `https://${follow.handle.split('@')[1]}/users/${follow.handle.split('@')[0]}`,
                        inboxUrl: follow.inboxUrl || `https://${follow.handle.split('@')[1]}/inbox`,
                        activityId: follow.activityId || `migrate-${uuid()}`,
                    });
                } else {
                    // Local follow - look up user and add to follows table
                    const targetUser = await db.query.users.findFirst({
                        where: { handle: follow.handle.toLowerCase() },
                    });
                    if (targetUser) {
                        await db.insert(follows).values({
                            followerId: newUser.id,
                            followingId: targetUser.id,
                        });
                        // Increment following count on target user
                        await db.update(users)
                            .set({ followersCount: sql`${users.followersCount} + 1` })
                            .where(eq(users.id, targetUser.id));
                    } else {
                        // Local user not found, convert to remote follow
                        console.log(`[Import] Local user @${follow.handle} not found, skipping follow`);
                    }
                }
                importedFollowing++;
            } catch (error) {
                console.error(`[Import] Failed to restore follow for @${follow.handle}:`, error);
            }
        }

        // Update user's following count
        await db.update(users)
            .set({ followingCount: importedFollowing })
            .where(eq(users.id, newUser.id));

        // Import each conversation and all of its messages atomically. A
        // failed message cannot leave a partial conversation behind.
        let importedDMs = 0;
        for (const conv of importDMs) {
            try {
                await db.transaction(async (tx) => {
                    const [newConv] = await tx.insert(chatConversations).values({
                        participant1Id: newUser.id,
                        participant2Handle: conv.participant2Handle,
                        type: conv.type,
                        lastMessageAt: conv.lastMessageAt ? new Date(conv.lastMessageAt) : null,
                        lastMessagePreview: conv.encryptionMode === 'e2ee'
                            ? 'Encrypted message'
                            : conv.lastMessagePreview,
                        encryptionMode: conv.encryptionMode,
                        e2eeActivatedAt: conv.e2eeActivatedAt ? new Date(conv.e2eeActivatedAt) : null,
                    }).returning();

                    for (const msg of conv.messages) {
                        await tx.insert(chatMessages).values({
                            conversationId: newConv.id,
                            senderHandle: msg.senderHandle,
                            senderDisplayName: msg.senderDisplayName,
                            senderAvatarUrl: msg.senderAvatarUrl,
                            senderNodeDomain: msg.senderNodeDomain,
                            senderDid: msg.senderDid,
                            content: msg.protocolVersion === 0 ? msg.content : null,
                            protocolVersion: msg.protocolVersion,
                            clientMessageId: msg.clientMessageId,
                            encryptedEnvelope: msg.encryptedEnvelope,
                            e2eeSignature: msg.e2eeSignature,
                            e2eeActionNonce: msg.e2eeActionNonce,
                            e2eeActionTs: msg.e2eeActionTs,
                            deliveredAt: msg.deliveredAt ? new Date(msg.deliveredAt) : null,
                            readAt: msg.readAt ? new Date(msg.readAt) : null,
                            createdAt: new Date(msg.createdAt),
                        });
                        if (msg.protocolVersion === 1 && msg.clientMessageId && msg.senderDid) {
                            await tx.insert(e2eeMessageReceipts).values({
                                ownerUserId: newUser.id,
                                senderDid: msg.senderDid,
                                messageId: msg.clientMessageId,
                            }).onConflictDoNothing();
                        }
                    }
                });
                importedDMs += 1;
            } catch (error) {
                console.error('Failed to import DM conversation:', error);
            }
        }

        // Notify old node about the migration
        try {
            await notifyOldNode(sourceNode, manifest.handle, newActorUrl, manifest.did, privateKey);
        } catch (error) {
            console.error('Failed to notify old node:', error);
            // Don't fail the import if notification fails
        }

        // Match registration/login behavior so the successful import can
        // redirect directly into the authenticated app. The imported email
        // and password hash also make ordinary email login work thereafter.
        let sessionWarning: string | null = null;
        try {
            await createSession(newUser.id);
        } catch (error) {
            console.error('Account imported but automatic sign-in failed:', error);
            sessionWarning = 'The account was imported, but automatic sign-in failed. Sign in with the destination email and import password.';
        }

        return NextResponse.json({
            success: true,
            signedIn: sessionWarning === null,
            user: {
                id: newUser.id,
                did: newUser.did,
                handle: newUser.handle,
                displayName: newUser.displayName,
                publicKey: newUser.publicKey,
                privateKeyEncrypted: newUser.privateKeyEncrypted,
            },
            stats: {
                postsImported: importedPosts,
                followingImported: importedFollowing,
                dmsImported: importedDMs,
            },
            warnings: [encryptedDMImportWarning, federatedMoveWarning, sessionWarning]
                .filter((warning): warning is string => warning !== null),
            message: 'Account imported successfully. The old node was notified of the move when reachable.',
        });

    } catch (error) {
        console.error('Import error:', error);
        return NextResponse.json({ error: 'Import failed' }, { status: 500 });
    }
}

/**
 * Notify the old node that the account has moved
 */
async function notifyOldNode(
    sourceNode: string,
    oldHandle: string,
    newActorUrl: string,
    did: string,
    privateKey: string
): Promise<void> {
    const payload = {
        oldHandle,
        newActorUrl,
        did,
        movedAt: new Date().toISOString(),
    };

    // Sign the payload
    const sign = crypto.createSign('sha256');
    sign.update(JSON.stringify(payload));
    const signature = sign.sign(privateKey, 'base64');

    const response = await safeFederationRequest(
      `${sourceNodeProtocol(sourceNode)}://${sourceNode}/api/account/moved`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            ...payload,
            signature,
        }),
        timeoutMs: 5_000,
        maxResponseBytes: 64 * 1024,
    });

    // The safe requester never follows redirects. Treat every non-2xx,
    // including redirects, as a failed best-effort notification.
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Old node returned ${response.status}`);
    }
}
