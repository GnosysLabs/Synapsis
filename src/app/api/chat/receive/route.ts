import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { chatConversations, chatMessages, users, handleRegistry } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { verifyActionSignature, type SignedAction } from '@/lib/auth/verify-signature';
import { verifySwarmRequest } from '@/lib/swarm/signature';
import { fetchAndCacheRemoteKey, logKeyChange } from '@/lib/swarm/identity-cache';
import { z } from 'zod';

const signedChatActionSchema = z.object({
    action: z.string().min(1),
    did: z.string().regex(/^did:/, 'Must be a valid DID'),
    handle: z.string().min(3).max(30),
    ts: z.number(),
    nonce: z.string().min(1),
    sig: z.string().min(1),
    data: z.object({
        recipientDid: z.string().regex(/^did:/, 'Must be a valid DID'),
        content: z.string().min(1).max(5000),
    }),
});

// Backward compatibility for older nodes that sent legacy field names.
const legacyChatActionSchema = z.object({
    did: z.string().regex(/^did:/, 'Must be a valid DID'),
    handle: z.string().min(3).max(30),
    data: z.object({
        recipientDid: z.string().regex(/^did:/, 'Must be a valid DID'),
        content: z.string().min(1).max(5000),
    }),
    signature: z.string().min(1),
    timestamp: z.number(),
});

const incomingChatActionSchema = z.union([signedChatActionSchema, legacyChatActionSchema]);

const federatedEnvelopeSchema = z.object({
    userAction: incomingChatActionSchema,
    fullSenderHandle: z.string().min(3).max(60),
    sourceDomain: z.string().min(1),
    ts: z.number(),
});

function normalizeSignedAction(action: z.infer<typeof incomingChatActionSchema>): SignedAction {
    if ('sig' in action) {
        return action;
    }

    return {
        action: 'chat',
        data: action.data,
        did: action.did,
        handle: action.handle,
        ts: action.timestamp,
        nonce: `legacy:${action.did}:${action.timestamp}`,
        sig: action.signature,
    };
}

/**
 * POST /api/chat/receive
 * Endpoint for receiving federated chat messages from other nodes.
 * Expects either:
 * 1. A SignedAction payload from the sender (legacy, for backward compatibility)
 * 2. A federated envelope with node's signature and user's signed action
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();

        // Check if this is a federated envelope (node-signed)
        const swarmSignature = request.headers.get('X-Swarm-Signature');
        const sourceDomain = request.headers.get('X-Swarm-Source-Domain');

        let signedAction: SignedAction;
        let fullSenderHandle: string | null = null;

        if (swarmSignature && sourceDomain && body.userAction) {
            // Federated envelope format - validate and verify node signature
            const envelopeValidation = federatedEnvelopeSchema.safeParse(body);
            if (!envelopeValidation.success) {
                return NextResponse.json(
                    { error: 'Invalid envelope payload', details: envelopeValidation.error.issues },
                    { status: 400 }
                );
            }

            const isValidNodeSig = await verifySwarmRequest(
                { userAction: body.userAction, fullSenderHandle: body.fullSenderHandle, sourceDomain: body.sourceDomain, ts: body.ts },
                swarmSignature,
                sourceDomain
            );

            if (!isValidNodeSig) {
                console.error('[Chat Receive] Invalid node signature from:', sourceDomain);
                return NextResponse.json({ error: 'Invalid node signature' }, { status: 403 });
            }

            // Extract user's signed action and full handle from envelope
            signedAction = normalizeSignedAction(body.userAction);
            fullSenderHandle = body.fullSenderHandle;
            console.log(`[Chat Receive] Federated envelope from node: ${sourceDomain}, full handle: ${fullSenderHandle}`);
        } else {
            // Legacy format - direct user signed action
            const actionValidation = incomingChatActionSchema.safeParse(body);
            if (!actionValidation.success) {
                return NextResponse.json(
                    { error: 'Invalid action payload', details: actionValidation.error.issues },
                    { status: 400 }
                );
            }
            signedAction = normalizeSignedAction(actionValidation.data);
        }

        const { did, handle, data } = signedAction;
        const { recipientDid, content } = data || {};

        // Use full handle if provided in envelope, otherwise fall back to signed handle
        const senderHandle = fullSenderHandle || handle;
        console.log(`[Chat Receive] From: ${senderHandle} (DID: ${did}), To: ${recipientDid}`);

        // 1. Resolve Sender Public Key
        let senderUser = await db.query.users.findFirst({
            where: eq(users.did, did)
        });

        let publicKey = senderUser?.publicKey;
        let senderDisplayName = senderUser?.displayName || senderHandle;
        let senderAvatarUrl = senderUser?.avatarUrl;
        let senderNodeDomain: string | null = null;

        if (!senderUser) {
            // Unknown user - likely remote. We need to fetch their profile to get the public key.
            // Derive domain from full sender handle if possible
            if (senderHandle.includes('@')) {
                const parts = senderHandle.split('@');
                senderNodeDomain = parts[parts.length - 1];
            } else {
                // Try to get from header first
                const sourceDomainHeader = request.headers.get('X-Swarm-Source-Domain');
                if (sourceDomainHeader) {
                    senderNodeDomain = sourceDomainHeader;
                } else {
                    // Try handle registry (though we likely don't have it if we don't have the user)
                    const registryEntry = await db.query.handleRegistry.findFirst({
                        where: eq(handleRegistry.did, did)
                    });
                    if (registryEntry) senderNodeDomain = registryEntry.nodeDomain;
                }
            }

            if (senderNodeDomain) {
                try {
                    const protocol = senderNodeDomain.includes('localhost') ? 'http' : 'https';
                    const remoteHandle = senderHandle.includes('@') ? senderHandle.split('@')[0] : senderHandle;

                    // Fetch public key with TOFU validation
                    const { publicKey: cachedOrFreshKey, fromCache, keyChanged } = await fetchAndCacheRemoteKey(
                        did,
                        senderHandle,
                        senderNodeDomain,
                        async () => {
                            // Fetch profile from remote node
                            const res = await fetch(`${protocol}://${senderNodeDomain}/api/users/${remoteHandle}`);
                            if (!res.ok) return null;
                            const profileData = await res.json();
                            const remoteProfile = profileData.user;
                            if (remoteProfile?.did !== did) {
                                console.error('[Chat Receive] DID mismatch for remote user');
                                return null;
                            }
                            return remoteProfile?.publicKey || null;
                        }
                    );

                    if (cachedOrFreshKey) {
                        publicKey = cachedOrFreshKey;
                        console.log(`[Chat Receive] Using ${fromCache ? 'cached' : 'fetched'} public key for ${senderHandle}${keyChanged ? ' (KEY CHANGED!)' : ''}`);

                        // Also fetch display name/avatar if not from cache (or if we need fresh data)
                        if (!fromCache || keyChanged) {
                            const res = await fetch(`${protocol}://${senderNodeDomain}/api/users/${remoteHandle}`);
                            if (res.ok) {
                                const profileData = await res.json();
                                const remoteProfile = profileData.user;
                                senderDisplayName = remoteProfile?.displayName || senderHandle;
                                senderAvatarUrl = remoteProfile?.avatarUrl;

                                // CACHE: Upsert the remote user into our local database
                                const { upsertRemoteUser } = await import('@/lib/swarm/user-cache');
                                await upsertRemoteUser({
                                    handle: senderHandle, // use full handle (user@domain)
                                    displayName: senderDisplayName,
                                    avatarUrl: senderAvatarUrl || null,
                                    did: did || '',
                                    isBot: remoteProfile.isBot || false
                                });
                            }
                        }
                    } else {
                        console.error('Failed to fetch remote profile: no key returned');
                    }
                } catch (e) {
                    console.error('Remote profile fetch failed:', e);
                }
            }
        }

        if (!publicKey) {
            return NextResponse.json({ error: 'Could not resolve sender public key' }, { status: 401 });
        }

        // 2. Verify Signature
        const isValid = await verifyActionSignature(signedAction, publicKey);
        if (!isValid) {
            return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
        }

        // 3. Find Local Recipient
        const recipientUser = await db.query.users.findFirst({
            where: eq(users.did, recipientDid)
        });

        if (!recipientUser) {
            return NextResponse.json({ error: 'Recipient not found on this node' }, { status: 404 });
        }

        // 4. Find or Create Conversation
        // For the RECIPIENT, the conversation is with the SENDER
        // Use full handle from envelope if available, otherwise construct from handle + domain
        const computedFullSenderHandle = senderHandle.includes('@') ? senderHandle : (senderNodeDomain ? `${senderHandle}@${senderNodeDomain}` : senderHandle);

        let conversation = await db.query.chatConversations.findFirst({
            where: and(
                eq(chatConversations.participant1Id, recipientUser.id),
                eq(chatConversations.participant2Handle, computedFullSenderHandle)
            )
        });

        if (!conversation) {
            const [newConv] = await db.insert(chatConversations).values({
                participant1Id: recipientUser.id,
                participant2Handle: computedFullSenderHandle,
                lastMessageAt: new Date(),
                lastMessagePreview: content.slice(0, 50)
            }).returning();
            conversation = newConv;
        } else {
            // Update preview
            await db.update(chatConversations)
                .set({
                    lastMessageAt: new Date(),
                    lastMessagePreview: content.slice(0, 50),
                    updatedAt: new Date()
                })
                .where(eq(chatConversations.id, conversation.id));
        }

        // 5. Store Message
        await db.insert(chatMessages).values({
            conversationId: conversation.id,
            senderHandle: computedFullSenderHandle,
            senderDisplayName: senderDisplayName,
            senderAvatarUrl: senderAvatarUrl,
            senderNodeDomain: senderNodeDomain,
            senderDid: did,
            content: content,
            deliveredAt: new Date(),
        });

        // 6. Update Registry (to ensure we can reply efficiently)
        if (senderNodeDomain) {
            await db.insert(handleRegistry).values({
                handle: computedFullSenderHandle, // user@domain
                did: did,
                nodeDomain: senderNodeDomain
            }).onConflictDoUpdate({
                target: handleRegistry.handle,
                set: {
                    did: did,
                    nodeDomain: senderNodeDomain
                }
            });
        }

        return NextResponse.json({ success: true });

    } catch (error: any) {
        console.error('Federated Receive Failed:', error);
        
        if (error instanceof z.ZodError) {
            return NextResponse.json(
                { error: 'Invalid input', details: error.issues },
                { status: 400 }
            );
        }
        
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
