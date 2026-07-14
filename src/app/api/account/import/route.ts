/**
 * Account Import API
 * 
 * Imports an account from another Synapsis node using the export package.
 * Creates the user with the same DID and migrates all data.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, users, posts, media, follows, remoteFollows, nodes, chatConversations, chatMessages, bots, botContentSources, botActivityLogs } from '@/db';
import { eq, sql } from 'drizzle-orm';
import * as crypto from 'crypto';
import { encryptApiKey, serializeEncryptedData } from '@/lib/bots/encryption';
import { v4 as uuid } from 'uuid';
import { upsertHandleEntries } from '@/lib/federation/handles';

interface ImportManifest {
    version: string;
    did: string;
    handle: string;
    sourceNode: string;
    exportedAt: string;
    expiresAt?: string; // Optional for backward compatibility
    publicKey: string;
    privateKeyEncrypted: string;
    salt: string;
    iv: string;
    signature: string;
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
    messages: ImportDMMessage[];
}

interface ImportDMMessage {
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

interface ImportBot {
    id: string;
    name: string;
    handle: string;
    bio: string | null;
    avatarUrl: string | null;
    headerUrl: string | null;
    personalityConfig: any;
    llmProvider: string;
    llmModel: string;
    llmApiKey: string;
    botPrivateKey: string;
    publicKey: string;
    scheduleConfig: any;
    autonomousMode: boolean;
    isActive: boolean;
    sources: any[];
    activityLogs: any[];
}

interface ImportPackage {
    manifest: ImportManifest;
    profile: ImportProfile;
    posts: ImportPost[];
    following: ImportFollowing[];
    dms: ImportDMConversation[];
    bots: ImportBot[];
}

/**
 * Decrypt the private key using the user's password
 */
function decryptPrivateKey(encrypted: string, password: string, salt: string, iv: string): string {
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

/**
 * Verify the manifest signature
 */
function verifyManifestSignature(manifest: ImportManifest): boolean {
    try {
        const { signature, ...manifestData } = manifest;
        const data = JSON.stringify(manifestData);

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
        const body = await req.json();
        const { exportData, password, newHandle, acceptedCompliance } = body as {
            exportData: ImportPackage;
            password: string;
            newHandle: string;
            acceptedCompliance: boolean;
        };

        // Validate required fields
        if (!exportData || !password || !newHandle) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }

        if (!acceptedCompliance) {
            return NextResponse.json({
                error: 'You must accept the content compliance agreement'
            }, { status: 400 });
        }

        const { manifest, profile, posts: importPosts, following } = exportData;

        // Validate manifest version
        if (manifest.version !== '1.0') {
            return NextResponse.json({ error: 'Unsupported export version' }, { status: 400 });
        }

        // Check if export has expired
        if (manifest.expiresAt) {
            const expiresAt = new Date(manifest.expiresAt);
            if (expiresAt < new Date()) {
                return NextResponse.json({ 
                    error: 'Export has expired. Please create a new export from your old node.' 
                }, { status: 400 });
            }
        }

        const { dms: importDMs = [], bots: importBots = [] } = exportData;

        // Verify signature
        if (!verifyManifestSignature(manifest)) {
            return NextResponse.json({ error: 'Invalid export signature' }, { status: 400 });
        }

        // Decrypt private key to verify password is correct
        let privateKey: string;
        try {
            privateKey = decryptPrivateKey(
                manifest.privateKeyEncrypted,
                password,
                manifest.salt,
                manifest.iv
            );
        } catch (error) {
            return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
        }

        // Check if DID already exists on this node
        const existingDid = await db.query.users.findFirst({
            where: { did: manifest.did },
        });

        if (existingDid) {
            return NextResponse.json({
                error: 'This account has already been imported to this node'
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
        const oldActorUrl = `https://${manifest.sourceNode}/users/${manifest.handle}`;
        const newActorUrl = `https://${nodeDomain}/users/${handleClean}`;

        // Create the user with the same DID
        const [newUser] = await db.insert(users).values({
            did: manifest.did,
            handle: handleClean,
            displayName: profile.displayName,
            bio: profile.bio,
            avatarUrl: profile.avatarUrl, // Note: URLs from old node might need re-uploading
            headerUrl: profile.headerUrl,
            publicKey: manifest.publicKey,
            privateKeyEncrypted: privateKey,
            movedFrom: oldActorUrl,
            migratedAt: new Date(),
            postsCount: importPosts.length,
        }).returning();

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

        // Import DMs
        for (const conv of importDMs) {
            try {
                const [newConv] = await db.insert(chatConversations).values({
                    participant1Id: newUser.id,
                    participant2Handle: conv.participant2Handle,
                    type: conv.type,
                    lastMessageAt: conv.lastMessageAt ? new Date(conv.lastMessageAt) : null,
                    lastMessagePreview: conv.lastMessagePreview
                }).returning();

                for (const msg of conv.messages) {
                    await db.insert(chatMessages).values({
                        conversationId: newConv.id,
                        senderHandle: msg.senderHandle,
                        senderDisplayName: msg.senderDisplayName,
                        senderAvatarUrl: msg.senderAvatarUrl,
                        senderNodeDomain: msg.senderNodeDomain,
                        senderDid: msg.senderDid,
                        content: msg.content,
                        deliveredAt: msg.deliveredAt ? new Date(msg.deliveredAt) : null,
                        readAt: msg.readAt ? new Date(msg.readAt) : null,
                        createdAt: new Date(msg.createdAt)
                    });
                }
            } catch (error) {
                console.error('Failed to import DM conversation:', error);
            }
        }

        // Import Bots
        for (const botData of importBots) {
            try {
                // 1. Create Bot User Account
                const botDid = `did:web:${nodeDomain}:users:${botData.handle.toLowerCase()}`;

                // Re-encrypt bot private key
                const encryptedBotPrivKey = encryptApiKey(botData.botPrivateKey);

                const [botUser] = await db.insert(users).values({
                    did: botDid,
                    handle: botData.handle.toLowerCase(),
                    displayName: botData.name,
                    bio: botData.bio,
                    avatarUrl: botData.avatarUrl,
                    headerUrl: botData.headerUrl,
                    publicKey: botData.publicKey,
                    privateKeyEncrypted: serializeEncryptedData(encryptedBotPrivKey),
                    isBot: true,
                    botOwnerId: newUser.id
                }).returning();

                // 2. Create Bot Config
                const encryptedLlmKey = encryptApiKey(botData.llmApiKey);

                const [newBot] = await db.insert(bots).values({
                    userId: botUser.id,
                    ownerId: newUser.id,
                    name: botData.name,
                    personalityConfig: JSON.stringify(botData.personalityConfig),
                    llmProvider: botData.llmProvider,
                    llmModel: botData.llmModel,
                    llmApiKeyEncrypted: serializeEncryptedData(encryptedLlmKey),
                    scheduleConfig: botData.scheduleConfig ? JSON.stringify(botData.scheduleConfig) : null,
                    autonomousMode: botData.autonomousMode,
                    isActive: botData.isActive
                }).returning();

                // 3. Import Sources
                for (const source of botData.sources) {
                    await db.insert(botContentSources).values({
                        botId: newBot.id,
                        type: source.type,
                        url: source.url,
                        subreddit: source.subreddit,
                        apiKeyEncrypted: source.apiKeyEncrypted,
                        sourceConfig: source.sourceConfig ? JSON.stringify(source.sourceConfig) : null,
                        keywords: source.keywords ? JSON.stringify(source.keywords) : null,
                        isActive: source.isActive
                    });
                }

                // 4. Import Activity Logs
                for (const log of botData.activityLogs) {
                    await db.insert(botActivityLogs).values({
                        botId: newBot.id,
                        action: log.action,
                        details: JSON.stringify(log.details),
                        success: log.success,
                        errorMessage: log.errorMessage,
                        createdAt: new Date(log.createdAt)
                    });
                }

            } catch (error) {
                console.error(`Failed to import bot ${botData.name}:`, error);
            }
        }

        // Notify old node about the migration
        try {
            await notifyOldNode(manifest.sourceNode, manifest.handle, newActorUrl, manifest.did, privateKey);
        } catch (error) {
            console.error('Failed to notify old node:', error);
            // Don't fail the import if notification fails
        }

        return NextResponse.json({
            success: true,
            user: {
                id: newUser.id,
                did: newUser.did,
                handle: newUser.handle,
                displayName: newUser.displayName,
            },
            stats: {
                postsImported: importedPosts,
                followingImported: importedFollowing,
                dmsImported: importDMs.length,
                botsImported: importBots.length,
            },
            message: 'Account imported successfully. Your followers on other Synapsis nodes will be automatically migrated.',
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

    const response = await fetch(`https://${sourceNode}/api/account/moved`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            ...payload,
            signature,
        }),
    });

    if (!response.ok) {
        throw new Error(`Old node returned ${response.status}`);
    }
}
