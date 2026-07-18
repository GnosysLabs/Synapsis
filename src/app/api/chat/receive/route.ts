import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import {
  chatConversations,
  chatMessages,
  db,
  e2eeMessageReceipts,
  handleRegistry,
} from '@/db';
import { verifyActionSignature, type SignedAction } from '@/lib/auth/verify-signature';
import { normalizeSigningPublicKey } from '@/lib/crypto/did-key';
import { signingPublicKeyFromDid } from '@/lib/e2ee/bundle-proof';
import {
  E2EE_MAX_MESSAGE_CIPHERTEXT_BYTES,
  E2EE_PROTOCOL_VERSION,
  e2eeMessageEnvelopeSchema,
  signedUserActionSchema,
  validateMessageBindings,
} from '@/lib/e2ee/protocol';
import { isNodeBlocked, normalizeNodeDomain } from '@/lib/swarm/node-blocklist';
import { safeFederationRequest } from '@/lib/swarm/safe-federation-http';
import { verifySwarmRequest } from '@/lib/swarm/signature';
import { isRateLimited } from '@/lib/rate-limit';

const federatedEnvelopeSchema = z.strictObject({
  userAction: signedUserActionSchema,
  fullSenderHandle: z.string().min(3).max(640),
  sourceDomain: z.string().min(1).max(253),
  destinationDomain: z.string().min(1).max(253),
  route: z.literal('/api/chat/receive'),
  deliveryId: z.string().min(12).max(512),
  ts: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
});

const remoteProfileResponseSchema = z.object({
  user: z.object({
    did: z.string(),
    publicKey: z.string(),
    displayName: z.string().nullish(),
    avatarUrl: z.string().nullish(),
    isNsfw: z.boolean().optional(),
    nodeIsNsfw: z.boolean().optional(),
  }).passthrough(),
}).passthrough();

class E2EEIdentityContinuityError extends Error {
  constructor() {
    super('Sender identity continuity check failed');
    this.name = 'E2EEIdentityContinuityError';
  }
}

const MAX_CONCURRENT_NODE_VERIFICATIONS = 32;
let activeNodeVerifications = 0;

export async function POST(request: NextRequest) {
  try {
    const swarmSignature = request.headers.get('X-Swarm-Signature');
    const sourceDomainHeader = request.headers.get('X-Swarm-Source-Domain');
    if (!swarmSignature || !sourceDomainHeader) {
      return NextResponse.json({
        error: 'Encrypted federated messages require a node-signed envelope',
        code: 'E2EE_REQUIRED',
      }, { status: 426 });
    }

    const body = federatedEnvelopeSchema.parse(await request.json());
    const sourceDomain = normalizeNodeDomain(sourceDomainHeader);
    if (normalizeNodeDomain(body.sourceDomain) !== sourceDomain) {
      return NextResponse.json({ error: 'Source node mismatch' }, { status: 403 });
    }
    const localDomain = normalizeNodeDomain(process.env.NEXT_PUBLIC_NODE_DOMAIN || '');
    if (!localDomain || normalizeNodeDomain(body.destinationDomain) !== localDomain) {
      return NextResponse.json({ error: 'Destination node mismatch' }, { status: 403 });
    }
    if (await isNodeBlocked(sourceDomain)) {
      return NextResponse.json({ error: 'Blocked node' }, { status: 403 });
    }
    if (Math.abs(Date.now() - body.ts) > 5 * 60 * 1000 || body.expiresAt < Date.now()
      || body.expiresAt - body.ts > 5 * 60 * 1000) {
      return NextResponse.json({ error: 'Federated envelope is stale' }, { status: 400 });
    }
    if (isRateLimited('e2ee-federation-preauth-global', 1_200, 60 * 1000)
      || activeNodeVerifications >= MAX_CONCURRENT_NODE_VERIFICATIONS) {
      return NextResponse.json({
        error: 'Federated encrypted-message verification is busy',
        code: 'E2EE_REMOTE_RATE_LIMITED',
      }, { status: 429, headers: { 'Retry-After': '60' } });
    }
    activeNodeVerifications += 1;
    let nodeSignatureValid = false;
    try {
      nodeSignatureValid = await verifySwarmRequest(body, swarmSignature, sourceDomain);
    } finally {
      activeNodeVerifications -= 1;
    }
    if (!nodeSignatureValid) {
      return NextResponse.json({ error: 'Invalid node signature' }, { status: 403 });
    }
    if (isRateLimited(`e2ee-federation-node:${sourceDomain}`, 600, 60 * 1000)) {
      return NextResponse.json({
        error: 'This node is sending encrypted messages too quickly',
        code: 'E2EE_REMOTE_RATE_LIMITED',
      }, { status: 429 });
    }

    const signedAction = body.userAction as SignedAction;
    const envelope = e2eeMessageEnvelopeSchema.parse(signedAction.data);
    validateMessageBindings(envelope, signedAction);
    if (Math.abs(Date.now() - signedAction.ts) > 5 * 60 * 1000) {
      return NextResponse.json({ error: 'Encrypted message action is stale' }, { status: 400 });
    }
    if (body.deliveryId !== `${envelope.messageId}:${normalizeNodeDomain(body.destinationDomain)}`) {
      return NextResponse.json({ error: 'Federated delivery identity mismatch' }, { status: 403 });
    }

    const senderHandle = body.fullSenderHandle.toLowerCase().replace(/^@/, '');
    const senderParts = senderHandle.split('@');
    if (senderParts.length !== 2
      || senderParts[0] !== signedAction.handle.toLowerCase()
      || normalizeNodeDomain(senderParts[1]) !== sourceDomain) {
      return NextResponse.json({ error: 'Federated sender handle mismatch' }, { status: 403 });
    }
    if (Buffer.from(envelope.nonce, 'base64url').length !== 24
      || Buffer.from(envelope.ciphertext, 'base64url').length < 17
      || Buffer.from(envelope.ciphertext, 'base64url').length > E2EE_MAX_MESSAGE_CIPHERTEXT_BYTES
      || Buffer.from(envelope.keyCommitment, 'base64url').length !== 32
      || envelope.keyEnvelopes.some((item) => Buffer.from(item.sealedKey, 'base64url').length !== 112)) {
      return NextResponse.json({ error: 'Invalid encrypted message sizes' }, { status: 400 });
    }

    // Reject nonexistent, unwilling, or stale-key recipients before resolving
    // or persisting any attacker-controlled remote user profile.
    const recipient = await db.query.users.findFirst({ where: { did: envelope.recipientDid } });
    if (!recipient || recipient.handle.includes('@') || recipient.id.startsWith('swarm:')) {
      return NextResponse.json({ error: 'Recipient not found on this node' }, { status: 404 });
    }
    const envelopeRecipientHandle = envelope.recipientHandle.toLowerCase().replace(/^@/, '');
    const recipientHandleParts = envelopeRecipientHandle.split('@');
    const recipientHandleMatches = recipientHandleParts.length === 1
      ? recipientHandleParts[0] === recipient.handle.toLowerCase()
      : recipientHandleParts.length === 2
        && recipientHandleParts[0] === recipient.handle.toLowerCase()
        && normalizeNodeDomain(recipientHandleParts[1]) === localDomain;
    if (!recipientHandleMatches) {
      return NextResponse.json({ error: 'Recipient identity mismatch' }, { status: 403 });
    }
    if (recipient.dmPrivacy === 'none') {
      return NextResponse.json({ error: 'Recipient does not accept direct messages' }, { status: 403 });
    }
    if (recipient.dmPrivacy === 'following') {
      const followsSender = await db.query.remoteFollows.findFirst({
        where: { AND: [{ followerId: recipient.id }, { targetHandle: senderHandle }] },
      });
      if (!followsSender) {
        return NextResponse.json({ error: 'Recipient only accepts messages from accounts they follow' }, { status: 403 });
      }
    }

    const [recipientKey, recipientVault] = await Promise.all([
      db.query.e2eeKeyBundles.findFirst({ where: { userId: recipient.id } }),
      db.query.e2eeKeyVaults.findFirst({ where: { userId: recipient.id } }),
    ]);
    if (!recipientKey || !recipientVault) {
      return NextResponse.json({
        error: recipientKey
          ? 'Recipient needs to finish encrypted message setup on this node'
          : 'Recipient has not set up encrypted messages',
        code: 'E2EE_NOT_CONFIGURED',
      }, { status: 409 });
    }
    if (recipientKey.keyId !== recipientVault.keyId
      || recipientKey.keyVersion !== recipientVault.keyVersion
      || recipientKey.publicKey !== recipientVault.publicKey
      || recipientVault.ownerDid !== recipient.did
      || recipientKey.keyId !== envelope.recipientKeyId
      || recipientKey.keyVersion !== envelope.recipientKeyVersion) {
      return NextResponse.json({
        error: 'Recipient encryption key changed',
        code: 'E2EE_RECIPIENT_KEY_STALE',
      }, { status: 409 });
    }

    let senderUser = await db.query.users.findFirst({ where: { did: signedAction.did } });
    if (senderUser && !senderUser.handle.includes('@') && !senderUser.id.startsWith('swarm:')) {
      return NextResponse.json({ error: 'A remote node cannot claim a local identity' }, { status: 403 });
    }
    if (senderUser && senderUser.handle !== senderHandle) {
      return NextResponse.json({ error: 'Sender identity continuity check failed' }, { status: 403 });
    }

    const didPublicKey = signingPublicKeyFromDid(signedAction.did);
    let signingPublicKey = didPublicKey || senderUser?.publicKey || null;
    let senderDisplayName = senderUser?.displayName || signedAction.handle;
    let senderAvatarUrl = senderUser?.avatarUrl || null;
    let resolvedProfile: z.infer<typeof remoteProfileResponseSchema>['user'] | null = null;
    let signatureVerified = !!signingPublicKey
      && await verifyActionSignature(signedAction, signingPublicKey);

    if (didPublicKey && !signatureVerified) {
      return NextResponse.json({ error: 'Invalid sender signature' }, { status: 403 });
    }

    if (!senderUser || !signatureVerified) {
      const isDevelopmentLoopback = process.env.NODE_ENV === 'development'
        && /^localhost(?::\d{1,5})?$/i.test(sourceDomain);
      const protocol = isDevelopmentLoopback ? 'http' : 'https';
      const profileResponse = await safeFederationRequest(`${protocol}://${sourceDomain}/api/users/${encodeURIComponent(signedAction.handle)}`, {
        headers: { Accept: 'application/json' },
        maxResponseBytes: 64 * 1024,
      });
      if (profileResponse.status < 200 || profileResponse.status >= 300) {
        return NextResponse.json({ error: 'Could not resolve sender identity' }, { status: 401 });
      }
      const profileData = remoteProfileResponseSchema.parse(profileResponse.json());
      const profile = profileData.user;
      if (profile?.did !== signedAction.did || !profile.publicKey) {
        return NextResponse.json({ error: 'Sender identity does not match their node profile' }, { status: 403 });
      }
      const profileSigningPublicKey = normalizeSigningPublicKey(profile.publicKey);
      if (!profileSigningPublicKey) {
        return NextResponse.json({ error: 'Sender profile contains an invalid signing key' }, { status: 403 });
      }
      if (didPublicKey && didPublicKey !== profileSigningPublicKey) {
        return NextResponse.json({ error: 'Sender signing key does not match their DID' }, { status: 403 });
      }
      const resolvedSigningPublicKey = didPublicKey || profileSigningPublicKey;
      signingPublicKey = resolvedSigningPublicKey;
      signatureVerified = await verifyActionSignature(signedAction, resolvedSigningPublicKey);
      if (!signatureVerified) {
        return NextResponse.json({ error: 'Invalid sender signature' }, { status: 403 });
      }
      senderDisplayName = profile.displayName || signedAction.handle;
      senderAvatarUrl = profile.avatarUrl || null;
      resolvedProfile = profile;
    }

    if (!signingPublicKey || !signatureVerified) {
      return NextResponse.json({ error: 'Invalid sender signature' }, { status: 403 });
    }

    if (isRateLimited(`e2ee-federation-sender:${sourceDomain}:${signedAction.did}`, 120, 60 * 1000)) {
      return NextResponse.json({
        error: 'This sender is sending encrypted messages too quickly',
        code: 'E2EE_REMOTE_RATE_LIMITED',
      }, { status: 429 });
    }
    if (senderUser) {
      const blocked = await db.query.blocks.findFirst({
        where: { AND: [{ userId: recipient.id }, { blockedUserId: senderUser.id }] },
      });
      if (blocked) return NextResponse.json({ error: 'Message not permitted' }, { status: 403 });
    }

    if (resolvedProfile) {
      const { upsertRemoteUser } = await import('@/lib/swarm/user-cache');
      await upsertRemoteUser({
        handle: senderHandle,
        displayName: senderDisplayName,
        avatarUrl: senderAvatarUrl,
        did: signedAction.did,
        publicKey: normalizeSigningPublicKey(resolvedProfile.publicKey)!,
        isNsfw: typeof resolvedProfile.isNsfw === 'boolean'
          ? resolvedProfile.isNsfw
          : undefined,
      });
      senderUser = await db.query.users.findFirst({ where: { did: signedAction.did } });
    }

    const createdAt = new Date(envelope.createdAt);
    await db.transaction(async (tx) => {
      const [receipt] = await tx.insert(e2eeMessageReceipts).values({
        ownerUserId: recipient.id,
        senderDid: signedAction.did,
        messageId: envelope.messageId,
      }).onConflictDoNothing().returning({ id: e2eeMessageReceipts.id });
      if (!receipt) return;

      const [insertedRegistryEntry] = await tx.insert(handleRegistry).values({
        handle: senderHandle,
        did: signedAction.did,
        nodeDomain: sourceDomain,
      }).onConflictDoNothing().returning({
        did: handleRegistry.did,
        nodeDomain: handleRegistry.nodeDomain,
      });
      const [registryEntry] = insertedRegistryEntry
        ? [insertedRegistryEntry]
        : await tx.select({
          did: handleRegistry.did,
          nodeDomain: handleRegistry.nodeDomain,
        }).from(handleRegistry).where(eq(handleRegistry.handle, senderHandle)).limit(1);
      if (!registryEntry
        || registryEntry.did !== signedAction.did
        || normalizeNodeDomain(registryEntry.nodeDomain) !== sourceDomain) {
        throw new E2EEIdentityContinuityError();
      }

      let [conversation] = await tx.select().from(chatConversations).where(and(
        eq(chatConversations.participant1Id, recipient.id),
        eq(chatConversations.participant2Handle, senderHandle),
      )).limit(1);
      if (!conversation) {
        [conversation] = await tx.insert(chatConversations).values({
          participant1Id: recipient.id,
          participant2Handle: senderHandle,
          lastMessageAt: createdAt,
          lastMessagePreview: 'Encrypted message',
          encryptionMode: 'e2ee',
          e2eeActivatedAt: createdAt,
        }).returning();
      } else {
        await tx.update(chatConversations).set({
          lastMessageAt: conversation.lastMessageAt && conversation.lastMessageAt > createdAt
            ? conversation.lastMessageAt
            : createdAt,
          lastMessagePreview: 'Encrypted message',
          encryptionMode: 'e2ee',
          e2eeActivatedAt: conversation.e2eeActivatedAt ?? createdAt,
          updatedAt: new Date(),
        }).where(eq(chatConversations.id, conversation.id));
      }
      if (!conversation) throw new Error('Failed to create encrypted conversation');

      await tx.insert(chatMessages).values({
        conversationId: conversation.id,
        senderHandle,
        senderDisplayName,
        senderAvatarUrl,
        senderNodeDomain: sourceDomain,
        senderDid: signedAction.did,
        content: null,
        protocolVersion: E2EE_PROTOCOL_VERSION,
        clientMessageId: envelope.messageId,
        encryptedEnvelope: JSON.stringify(envelope),
        e2eeSignature: signedAction.sig,
        e2eeActionNonce: signedAction.nonce,
        e2eeActionTs: signedAction.ts,
        deliveredAt: new Date(),
        createdAt,
      });
    });

    return NextResponse.json({ success: true, messageId: envelope.messageId });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({
        error: 'This node only accepts encrypted message envelopes',
        code: 'E2EE_REQUIRED',
        details: error.issues,
      }, { status: 426 });
    }
    if (error instanceof E2EEIdentityContinuityError) {
      return NextResponse.json({
        error: error.message,
        code: 'E2EE_IDENTITY_KEY_CHANGED',
      }, { status: 409 });
    }
    console.error('[E2EE Chat] Federated receive failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Receive failed' }, { status: 500 });
  }
}
