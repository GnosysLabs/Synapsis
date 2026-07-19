import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import {
  chatConversations,
  chatMessages,
  db,
  e2eeMessageReceipts,
} from '@/db';
import { normalizeSigningPublicKey } from '@/lib/crypto/did-key';
import { signingPublicKeyFromDid } from '@/lib/e2ee/bundle-proof';
import {
  E2EE_CHAT_ACTION,
  E2EE_MAX_MESSAGE_CIPHERTEXT_BYTES,
  E2EE_PROTOCOL_VERSION,
  e2eeMessageEnvelopeSchema,
  signedUserActionSchema,
  validateMessageBindings,
} from '@/lib/e2ee/protocol';
import { enqueueMessagePushDeliveries } from '@/lib/push/messages';
import { isNodeBlocked } from '@/lib/swarm/node-blocklist';
import {
  FederatedIdentityContinuityError,
  federationActionContextSchema,
  federationActionDomain,
  pinVerifiedFederatedActorIdentity,
  verifyFederatedUserAction,
} from '@/lib/swarm/federated-action';
import {
  E2EE_FEDERATION_MAX_REQUEST_BYTES,
} from '@/lib/swarm/safe-federation-http';
import { FederationRequestBodyError, readLimitedJson } from '@/lib/swarm/request-body';
import { localHandleSchema } from '@/lib/utils/federation';

const PATH = '/api/chat/receive' as const;

const federatedEnvelopeSchema = z.strictObject({
  federation: federationActionContextSchema,
  userAction: signedUserActionSchema,
  fullSenderHandle: z.string().min(3).max(640),
  deliveryId: z.string().min(12).max(512),
});

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

    const body = federatedEnvelopeSchema.parse(await readLimitedJson(
      request,
      E2EE_FEDERATION_MAX_REQUEST_BYTES,
    ));
    const sourceDomain = federationActionDomain(sourceDomainHeader);
    if (!sourceDomain) {
      return NextResponse.json({ error: 'Invalid source node' }, { status: 403 });
    }
    const senderHandle = body.fullSenderHandle.toLowerCase().replace(/^@/, '');
    const senderParts = senderHandle.split('@');
    const actorHandle = senderParts.length === 2
      ? localHandleSchema.safeParse(senderParts[0])
      : null;
    if (!actorHandle?.success || federationActionDomain(senderParts[1]) !== sourceDomain) {
      return NextResponse.json({ error: 'Federated sender handle mismatch' }, { status: 403 });
    }
    if (await isNodeBlocked(sourceDomain)) {
      return NextResponse.json({ error: 'Blocked node' }, { status: 403 });
    }

    const verified = await verifyFederatedUserAction({
      payload: body,
      nodeSignature: swarmSignature,
      sourceDomain,
      expectedMethod: 'POST',
      expectedPath: PATH,
      expectedAction: E2EE_CHAT_ACTION,
      actorHandle: actorHandle.data,
      replayBinding: {
        deliveryId: body.deliveryId,
        fullSenderHandle: senderHandle,
      },
      maxActionsPerMinute: 120,
      maxNodeActionsPerMinute: 600,
    });
    if (!verified.ok) {
      return NextResponse.json({ error: verified.error }, { status: verified.status });
    }

    const signedAction = verified.userAction;
    const envelope = e2eeMessageEnvelopeSchema.parse(signedAction.data);
    try {
      validateMessageBindings(envelope, signedAction);
    } catch {
      return NextResponse.json({ error: 'Encrypted message user authorization is invalid' }, { status: 403 });
    }
    if (body.deliveryId !== `${envelope.messageId}:${verified.destinationDomain}`) {
      return NextResponse.json({ error: 'Federated delivery identity mismatch' }, { status: 403 });
    }
    if (senderHandle !== `${verified.actorHandle}@${verified.sourceDomain}`) {
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
    const recipientHandleMatches = recipientHandleParts.length === 2
      && recipientHandleParts[0] === recipient.handle.toLowerCase()
      && federationActionDomain(recipientHandleParts[1]) === verified.destinationDomain;
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

    const [senderByDid, senderByHandle] = await Promise.all([
      db.query.users.findFirst({ where: { did: signedAction.did } }),
      db.query.users.findFirst({ where: { handle: senderHandle } }),
    ]);
    if ((senderByDid && !senderByDid.handle.includes('@') && !senderByDid.id.startsWith('swarm:'))
      || (senderByHandle && !senderByHandle.handle.includes('@') && !senderByHandle.id.startsWith('swarm:'))) {
      return NextResponse.json({ error: 'A remote node cannot claim a local identity' }, { status: 403 });
    }
    if ((senderByDid && senderByDid.handle !== senderHandle)
      || (senderByHandle && senderByHandle.did !== signedAction.did)
      || (senderByDid && senderByHandle && senderByDid.id !== senderByHandle.id)) {
      throw new FederatedIdentityContinuityError();
    }

    const didPublicKey = signingPublicKeyFromDid(signedAction.did);
    if (!didPublicKey) {
      return NextResponse.json({ error: 'Encrypted messages require a self-certifying sender DID' }, { status: 403 });
    }
    const senderUser = senderByDid || senderByHandle || null;
    if (senderUser?.publicKey
      && normalizeSigningPublicKey(senderUser.publicKey) !== didPublicKey) {
      throw new FederatedIdentityContinuityError();
    }
    // The protocol does not currently include a user signature over display or
    // avatar metadata, so neither the hostile transport nor a node-populated
    // profile cache is authoritative for those fields. Attachments remain inside
    // the signed opaque ciphertext and are validated client-side only after
    // successful decryption.
    const senderDisplayName = verified.actorHandle;
    const senderAvatarUrl = null;
    if (senderUser) {
      const blocked = await db.query.blocks.findFirst({
        where: { AND: [{ userId: recipient.id }, { blockedUserId: senderUser.id }] },
      });
      if (blocked) return NextResponse.json({ error: 'Message not permitted' }, { status: 403 });
    }

    const createdAt = new Date(envelope.createdAt);
    await db.transaction(async (tx) => {
      // Promote the verified action to an authoritative identity pin only after
      // the destination recipient and their encryption key have been validated.
      // Keep it atomic with replay/message creation, and never treat an
      // unverified gossip hint as continuity authority.
      await pinVerifiedFederatedActorIdentity({
        sourceDomain: verified.sourceDomain,
        actorHandle: verified.actorHandle,
        did: signedAction.did,
      }, tx);

      const [receipt] = await tx.insert(e2eeMessageReceipts).values({
        ownerUserId: recipient.id,
        senderDid: signedAction.did,
        messageId: envelope.messageId,
      }).onConflictDoNothing().returning({ id: e2eeMessageReceipts.id });
      if (!receipt) return;

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

      const [message] = await tx.insert(chatMessages).values({
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
      }).returning({ id: chatMessages.id });
      if (!message) throw new Error('Failed to store the recipient message');
      await enqueueMessagePushDeliveries(tx, recipient.id, message.id);
    });

    return NextResponse.json({ success: true, messageId: envelope.messageId });
  } catch (error) {
    if (error instanceof FederationRequestBodyError) {
      return NextResponse.json({
        error: error.message,
        code: error.status === 413 ? 'E2EE_MESSAGE_TOO_LARGE' : 'E2EE_REQUIRED',
      }, { status: error.status });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({
        error: 'This node only accepts encrypted message envelopes',
        code: 'E2EE_REQUIRED',
        details: error.issues,
      }, { status: 426 });
    }
    if (error instanceof FederatedIdentityContinuityError) {
      return NextResponse.json({
        error: error.message,
        code: 'E2EE_IDENTITY_KEY_CHANGED',
      }, { status: 409 });
    }
    console.error('[E2EE Chat] Federated receive failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Receive failed' }, { status: 500 });
  }
}
