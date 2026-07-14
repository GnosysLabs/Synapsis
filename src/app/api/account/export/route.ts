/**
 * Account Export API
 * 
 * Generates a ZIP archive containing the user's complete account data
 * for migration to another Synapsis node.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyPassword } from '@/lib/auth';
import { db, posts, media, follows, users, remoteFollows, chatConversations, chatMessages, bots, botContentSources, botActivityLogs } from '@/db';
import { eq } from 'drizzle-orm';
import * as crypto from 'crypto';
import { decryptApiKey, deserializeEncryptedData } from '@/lib/bots/encryption';

// We'll use a simple in-memory zip approach
// For production, consider using a streaming zip library

interface ExportManifest {
    version: string;
    did: string;
    handle: string;
    sourceNode: string;
    exportedAt: string;
    expiresAt: string; // Export expiration timestamp
    publicKey: string;
    privateKeyEncrypted: string; // Encrypted with user's password
    salt: string; // For key derivation
    iv: string; // For AES encryption
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
    messages: ExportDMMessage[];
}

interface ExportDMMessage {
    senderHandle: string;
    senderDisplayName: string | null;
    senderAvatarUrl: string | null;
    senderNodeDomain: string | null;
    senderDid: string | null;
    content: string | null;
    deliveredAt: string | null;
    readAt: string | null;
    createdAt: string;
}

interface ExportBot {
    id: string;
    name: string;
    handle: string;
    bio: string | null;
    avatarUrl: string | null;
    headerUrl: string | null;
    personalityConfig: any;
    llmProvider: string;
    llmModel: string;
    llmApiKey: string; // Decrypted
    botPrivateKey: string; // Decrypted
    publicKey: string;
    scheduleConfig: any;
    autonomousMode: boolean;
    isActive: boolean;
    sources: any[];
    activityLogs: any[];
}

/**
 * Encrypt the private key with user's password using AES-256-GCM
 */
function encryptPrivateKey(privateKey: string, password: string): { encrypted: string; salt: string; iv: string } {
    const salt = crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);

    // Derive key from password
    const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');

    // Encrypt
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(privateKey, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag();

    // Combine encrypted data with auth tag
    const combined = Buffer.concat([Buffer.from(encrypted, 'base64'), authTag]).toString('base64');

    return {
        encrypted: combined,
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
    };
}

/**
 * Sign the manifest to prove ownership
 */
function signManifest(manifest: Omit<ExportManifest, 'signature'>, privateKey: string): string {
    const data = JSON.stringify(manifest);
    const sign = crypto.createSign('sha256');
    sign.update(data);
    return sign.sign(privateKey, 'base64');
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

        const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';

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

        // Fetch Bots
        const userBots = await db.query.bots.findMany({
            where: { ownerId: user.id },
            with: {
                user: true,
                contentSources: true,
                activityLogs: {
                    limit: 50,
                    orderBy: (logs, { desc }) => [desc(logs.createdAt)]
                }
            }
        });

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
                return {
                    actorUrl: `https://${nodeDomain}/users/${followingUser.handle}`,
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
                bio: f.bio,
                avatarUrl: f.avatarUrl,
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
            messages: conv.messages.map(msg => ({
                senderHandle: msg.senderHandle,
                senderDisplayName: msg.senderDisplayName,
                senderAvatarUrl: msg.senderAvatarUrl,
                senderNodeDomain: msg.senderNodeDomain,
                senderDid: msg.senderDid,
                content: msg.content,
                deliveredAt: msg.deliveredAt?.toISOString() || null,
                readAt: msg.readAt?.toISOString() || null,
                createdAt: msg.createdAt.toISOString()
            }))
        }));

        const exportBots: ExportBot[] = userBots.map(bot => {
            // Decrypt bot keys
            let llmApiKey = '';
            let botPrivateKey = '';
            try {
                if (bot.llmApiKeyEncrypted) {
                    llmApiKey = decryptApiKey(deserializeEncryptedData(bot.llmApiKeyEncrypted));
                }
                if (bot.user?.privateKeyEncrypted) {
                    botPrivateKey = decryptApiKey(deserializeEncryptedData(bot.user.privateKeyEncrypted));
                }
            } catch (e) {
                console.error(`Failed to decrypt keys for bot ${bot.name}:`, e);
            }

            return {
                id: bot.id,
                name: bot.name,
                handle: bot.user.handle,
                bio: bot.user.bio,
                avatarUrl: bot.user.avatarUrl,
                headerUrl: bot.user.headerUrl,
                personalityConfig: JSON.parse(bot.personalityConfig),
                llmProvider: bot.llmProvider,
                llmModel: bot.llmModel,
                llmApiKey,
                botPrivateKey,
                publicKey: bot.user.publicKey,
                scheduleConfig: bot.scheduleConfig ? JSON.parse(bot.scheduleConfig) : null,
                autonomousMode: bot.autonomousMode,
                isActive: bot.isActive,
                sources: bot.contentSources.map(s => ({
                    type: s.type,
                    url: s.url,
                    subreddit: s.subreddit,
                    apiKeyEncrypted: s.apiKeyEncrypted, // These are specific to sources and might need their own decryption if they use AUTH_SECRET
                    sourceConfig: s.sourceConfig ? JSON.parse(s.sourceConfig) : null,
                    keywords: s.keywords ? JSON.parse(s.keywords) : null,
                    isActive: s.isActive
                })),
                activityLogs: bot.activityLogs.map(l => ({
                    action: l.action,
                    details: JSON.parse(l.details),
                    success: l.success,
                    errorMessage: l.errorMessage,
                    createdAt: l.createdAt.toISOString()
                }))
            };
        });

        // Encrypt private key
        const privateKey = user.privateKeyEncrypted || '';
        const { encrypted, salt, iv } = encryptPrivateKey(privateKey, password);

        // Build manifest (without signature first)
        const exportedAt = new Date();
        const expiresAt = new Date(exportedAt.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days
        const manifestData: Omit<ExportManifest, 'signature'> = {
            version: '1.0',
            did: user.did,
            handle: user.handle,
            sourceNode: nodeDomain,
            exportedAt: exportedAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
            publicKey: user.publicKey,
            privateKeyEncrypted: encrypted,
            salt,
            iv,
        };

        // Sign the manifest
        const signature = signManifest(manifestData, privateKey);
        const manifest: ExportManifest = { ...manifestData, signature };

        // Build the export package as JSON (ZIP would require additional library)
        // For MVP, we'll use a JSON format that can be easily converted to ZIP later
        const exportPackage = {
            manifest,
            profile,
            posts: exportPosts,
            following: exportFollowing,
            dms: exportDMs,
            bots: exportBots,
        };

        return NextResponse.json({
            success: true,
            export: exportPackage,
            stats: {
                posts: exportPosts.length,
                following: exportFollowing.length,
                dms: exportDMs.length,
                bots: exportBots.length,
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
