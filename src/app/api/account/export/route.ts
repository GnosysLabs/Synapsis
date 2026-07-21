/**
 * Account Export API
 * 
 * Generates a ZIP archive containing the user's complete account data
 * for migration to another Synapsis node.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyPassword } from '@/lib/auth';
import { db } from '@/db';
import * as crypto from 'crypto';
import { canonicalize, verifySignedActionSignature } from '@/lib/crypto/user-signing';
import {
    decryptPrivateKey as decryptStoredPrivateKey,
    deserializeEncryptedKey,
} from '@/lib/crypto/private-key';
import {
    E2EE_KEY_BUNDLE_ACTION,
    e2eeKeyBundleSchema,
    signedUserActionSchema,
    type SignedUserAction,
} from '@/lib/e2ee/protocol';
import { encryptionKeyIdFromPublicKey } from '@/lib/e2ee/bundle-proof';
import { shouldIncludeNsfwFeed } from '@/lib/nsfw/feed-access';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { accountUsername, resolveAccountAddress } from '@/lib/identity/account-address';

// We'll use a simple in-memory zip approach
// For production, consider using a streaming zip library

interface ExportManifest {
    version: '1.1';
    did: string;
    handle: string;
    sourceNode: string;
    exportedAt: string;
    expiresAt: string; // Export expiration timestamp
    publicKey: string;
    privateKeyEncrypted: string; // Original serialized AES-GCM key blob
    payloadDigestAlgorithm: 'sha256';
    payloadDigest: string; // Canonical digest of every non-manifest export field
    signature: string; // Proof of ownership
}

interface ExportProfile {
    displayName: string | null;
    bio: string | null;
    avatarUrl: string | null;
    headerUrl: string | null;
}

interface ExportPost {
    id: string;
    content: string;
    createdAt: string;
    replyToApId: string | null;
    media: { filename: string; url: string; altText: string | null; isIPFS?: boolean }[];
}

interface ExportFollowing {
    actorUrl: string;
    handle: string;
    isRemote?: boolean;
    displayName?: string | null;
    bio?: string | null;
    avatarUrl?: string | null;
}

interface ExportDMConversation {
    id: string;
    type: string;
    participant2Handle: string;
    lastMessageAt: string | null;
    lastMessagePreview: string | null;
    encryptionMode: string;
    e2eeActivatedAt: string | null;
    messages: ExportDMMessage[];
}

interface ExportDMMessage {
    senderHandle: string;
    senderDisplayName: string | null;
    senderAvatarUrl: string | null;
    senderNodeDomain: string | null;
    senderDid: string | null;
    content: string | null;
    protocolVersion: number;
    clientMessageId: string | null;
    encryptedEnvelope: string | null;
    e2eeSignature: string | null;
    e2eeActionNonce: string | null;
    e2eeActionTs: number | null;
    deliveredAt: string | null;
    readAt: string | null;
    createdAt: string;
}

interface ExportE2EEContinuityAnchor {
    did: string;
    keyId: string;
    keyVersion: number;
    publicKey: string;
    proofAction: SignedUserAction;
}

interface ExportPayload {
    profile: ExportProfile;
    posts: ExportPost[];
    following: ExportFollowing[];
    dms: ExportDMConversation[];
    e2eeKeyBundle: ExportE2EEContinuityAnchor | null;
}

/**
 * Sign the manifest to prove ownership
 */
function signManifest(manifest: Omit<ExportManifest, 'signature'>, privateKey: string): string {
    const data = canonicalize(manifest);
    const sign = crypto.createSign('sha256');
    sign.update(data);
    return sign.sign(privateKey, 'base64');
}

function digestExportPayload(payload: ExportPayload): string {
    return crypto.createHash('sha256').update(canonicalize(payload)).digest('hex');
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

async function exportE2EEContinuityAnchor(
    row: {
        did: string;
        keyId: string;
        keyVersion: number;
        publicKey: string;
        proofAction: string;
    } | undefined,
    user: { did: string; handle: string; homeDomain: string; publicKey: string },
): Promise<ExportE2EEContinuityAnchor | null> {
    if (!row) return null;

    const proof = signedUserActionSchema.parse(JSON.parse(row.proofAction));
    const bundle = e2eeKeyBundleSchema.parse(proof.data);
    const proofAddress = resolveAccountAddress(proof.handle, user.homeDomain);
    if (proof.action !== E2EE_KEY_BUNDLE_ACTION
        || proof.did !== user.did
        || proofAddress?.canonical !== user.handle
        || row.did !== proof.did
        || row.keyId !== bundle.keyId
        || row.keyVersion !== bundle.version
        || row.publicKey !== bundle.publicKey
        || Math.abs(bundle.createdAt - proof.ts) > 5 * 60 * 1_000
        || Buffer.from(bundle.publicKey, 'base64url').length !== 32
        || Buffer.from(bundle.recoveryCommitment, 'base64url').length !== 32
        || await encryptionKeyIdFromPublicKey(bundle.publicKey) !== bundle.keyId
        || !await verifySignedActionSignature(proof, user.publicKey)) {
        throw new Error('Stored E2EE continuity proof is invalid');
    }

    return {
        did: row.did,
        keyId: row.keyId,
        keyVersion: row.keyVersion,
        publicKey: row.publicKey,
        proofAction: proof,
    };
}

export async function POST(req: NextRequest) {
    try {
        const user = await requireAuth();

        const body = await req.json();
        const { password } = body;

        if (!password) {
            return NextResponse.json({ error: 'Password required for export' }, { status: 400 });
        }

        // Verify password
        if (!user.passwordHash) {
            return NextResponse.json({ error: 'Account has no password set' }, { status: 400 });
        }

        const isValid = await verifyPassword(password, user.passwordHash);
        if (!isValid) {
            return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
        }

        // Check if account has already moved
        if (user.movedTo) {
            return NextResponse.json({ error: 'This account has already been migrated' }, { status: 400 });
        }

        if (!user.privateKeyEncrypted) {
            return NextResponse.json({ error: 'Account signing key is unavailable' }, { status: 500 });
        }

        let signingPrivateKey: string;
        try {
            signingPrivateKey = decryptStoredPrivateKey(
                deserializeEncryptedKey(user.privateKeyEncrypted),
                password,
            );
        } catch {
            return NextResponse.json({ error: 'Account signing key could not be unlocked' }, { status: 500 });
        }
        if (!signingKeyMatchesPublicKey(signingPrivateKey, user.publicKey)) {
            return NextResponse.json({ error: 'Account signing key does not match this account' }, { status: 500 });
        }

        const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';
        const canViewSensitive = shouldIncludeNsfwFeed({
            viewer: user,
            localNodeIsNsfw: await requireLocalNodeNsfwClassification(),
        });

        // Fetch user's posts
        const userPosts = await db.query.posts.findMany({
            where: { userId: user.id },
            with: {
                media: true,
            },
            orderBy: (posts, { desc }) => [desc(posts.createdAt)],
        });

        // Fetch user's following list (local and remote)
        const userFollowing = await db.query.follows.findMany({
            where: { followerId: user.id },
            with: {
                following: true,
            },
        });

        const userRemoteFollowing = await db.query.remoteFollows.findMany({
            where: { followerId: user.id },
        });

        // Fetch DMs
        const userConversations = await db.query.chatConversations.findMany({
            where: { participant1Id: user.id },
            with: {
                messages: true
            }
        });

        const currentE2EEKeyBundle = await db.query.e2eeKeyBundles.findFirst({
            where: { userId: user.id },
        });
        const e2eeKeyBundle = await exportE2EEContinuityAnchor(currentE2EEKeyBundle, user);

        // Build export data
        const exportPosts: ExportPost[] = userPosts.map(post => ({
            id: post.id,
            content: post.content,
            createdAt: post.createdAt.toISOString(),
            replyToApId: post.replyToId ? `https://${nodeDomain}/posts/${post.replyToId}` : null,
            media: (post.media || []).map((m, idx) => ({
                filename: `${post.id}_${idx}${getExtension(m.url)}`,
                url: m.url,
                altText: m.altText,
                isIPFS: m.url?.startsWith('ipfs://') || false,
            })),
        }));

        const exportFollowing: ExportFollowing[] = [
            // Local follows
            ...userFollowing.map(f => {
                const followingUser = f.following as { handle: string };
                const username = accountUsername(followingUser.handle);
                if (!username) throw new Error('Followed account identity is not canonical');
                return {
                    actorUrl: `https://${nodeDomain}/users/${username}`,
                    handle: followingUser.handle,
                    isRemote: false,
                };
            }),
            // Remote follows
            ...userRemoteFollowing.map(f => ({
                actorUrl: f.targetActorUrl,
                handle: f.targetHandle,
                isRemote: true,
                displayName: f.displayName,
                // Legacy remote-follow snapshots do not carry authoritative
                // account/node classifiers. Treat their profile media and bio
                // as sensitive when the exporting viewer has NSFW disabled.
                bio: canViewSensitive ? f.bio : null,
                avatarUrl: canViewSensitive ? f.avatarUrl : null,
            })),
        ];

        const profile: ExportProfile = {
            displayName: user.displayName,
            bio: user.bio,
            avatarUrl: user.avatarUrl,
            headerUrl: user.headerUrl,
        };

        const exportDMs: ExportDMConversation[] = userConversations.map(conv => ({
            id: conv.id,
            type: conv.type,
            participant2Handle: conv.participant2Handle,
            lastMessageAt: conv.lastMessageAt?.toISOString() || null,
            lastMessagePreview: conv.lastMessagePreview,
            encryptionMode: conv.encryptionMode,
            e2eeActivatedAt: conv.e2eeActivatedAt?.toISOString() || null,
            messages: conv.messages.map(msg => ({
                senderHandle: msg.senderHandle,
                senderDisplayName: msg.senderDisplayName,
                senderAvatarUrl: canViewSensitive
                    || msg.senderDid === user.did
                    || msg.senderHandle === user.handle
                    ? msg.senderAvatarUrl
                    : null,
                senderNodeDomain: msg.senderNodeDomain,
                senderDid: msg.senderDid,
                content: msg.protocolVersion === 0 ? msg.content : null,
                protocolVersion: msg.protocolVersion,
                clientMessageId: msg.clientMessageId,
                encryptedEnvelope: msg.encryptedEnvelope,
                e2eeSignature: msg.e2eeSignature,
                e2eeActionNonce: msg.e2eeActionNonce,
                e2eeActionTs: msg.e2eeActionTs,
                deliveredAt: msg.deliveredAt?.toISOString() || null,
                readAt: msg.readAt?.toISOString() || null,
                createdAt: msg.createdAt.toISOString()
            }))
        }));

        const exportPayload: ExportPayload = {
            profile,
            posts: exportPosts,
            following: exportFollowing,
            dms: exportDMs,
            e2eeKeyBundle,
        };

        // Version 1.1 fails closed on older importers and binds a canonical
        // digest of every non-manifest field into the signed manifest.
        const exportedAt = new Date();
        const expiresAt = new Date(exportedAt.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days
        const manifestData: Omit<ExportManifest, 'signature'> = {
            version: '1.1',
            did: user.did,
            handle: user.handle,
            sourceNode: nodeDomain,
            exportedAt: exportedAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
            publicKey: user.publicKey,
            privateKeyEncrypted: user.privateKeyEncrypted,
            payloadDigestAlgorithm: 'sha256',
            payloadDigest: digestExportPayload(exportPayload),
        };

        // Sign the manifest
        const signature = signManifest(manifestData, signingPrivateKey);
        const manifest: ExportManifest = { ...manifestData, signature };

        // Build the export package as JSON (ZIP would require additional library)
        // For MVP, we'll use a JSON format that can be easily converted to ZIP later
        const exportPackage = {
            manifest,
            ...exportPayload,
        };

        return NextResponse.json({
            success: true,
            export: exportPackage,
            stats: {
                posts: exportPosts.length,
                following: exportFollowing.length,
                dms: exportDMs.length,
                mediaFiles: exportPosts.reduce((sum, p) => sum + p.media.length, 0),
            },
        });

    } catch (error) {
        if (error instanceof Error && error.message === 'Authentication required') {
            return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
        }
        console.error('Export error:', error);
        return NextResponse.json({ error: 'Export failed' }, { status: 500 });
    }
}

function getExtension(url: string): string {
    const match = url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
    return match ? `.${match[1]}` : '.bin';
}
