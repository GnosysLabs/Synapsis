import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import {
  chatConversations,
  chatMessages,
  db,
  e2eeMessageReceipts,
} from '@/db';
import { requireSignedAction, SignedActionError, type SignedAction } from '@/lib/auth/verify-signature';
import {
  E2EE_MAX_MESSAGE_CIPHERTEXT_BYTES,
  E2EE_PROTOCOL_VERSION,
  e2eeMessageEnvelopeSchema,
  signedUserActionSchema,
  validateMessageBindings,
} from '@/lib/e2ee/protocol';
import { enqueueMessagePushDeliveries } from '@/lib/push/messages';
import { createFederationActionContext } from '@/lib/swarm/federated-action';
import { createSignedPayload } from '@/lib/swarm/signature';
import { isNodeBlocked, normalizeNodeDomain } from '@/lib/swarm/node-blocklist';
import { getPublicSwarmDomain } from '@/lib/swarm/node-domain';
import { safeFederationRequest } from '@/lib/swarm/safe-federation-http';
import { parseAccountAddress } from '@/lib/identity/account-address';

function validateCiphertextLengths(envelope: z.infer<typeof e2eeMessageEnvelopeSchema>): void {
  if (Buffer.from(envelope.nonce, 'base64url').length !== 24) throw new Error('Invalid message nonce');
  const ciphertextLength = Buffer.from(envelope.ciphertext, 'base64url').length;
  if (ciphertextLength < 17 || ciphertextLength > E2EE_MAX_MESSAGE_CIPHERTEXT_BYTES) {
    throw new Error('Invalid encrypted message');
  }
  if (Buffer.from(envelope.keyCommitment, 'base64url').length !== 32) {
    throw new Error('Invalid encrypted message key commitment');
  }
  for (const wrappedKey of envelope.keyEnvelopes) {
    if (Buffer.from(wrappedKey.sealedKey, 'base64url').length !== 112) {
      throw new Error('Invalid encrypted message key');
    }
  }
}

function messageValues(input: {
  conversationId: string;
  senderHandle: string;
  senderDisplayName: string | null;
  senderAvatarUrl: string | null;
  senderDid: string;
  senderHomeDomain: string;
  envelope: z.infer<typeof e2eeMessageEnvelopeSchema>;
  signedAction: SignedAction;
  createdAt: Date;
  readAt?: Date;
}) {
  return {
    conversationId: input.conversationId,
    senderHandle: input.senderHandle,
    senderDisplayName: input.senderDisplayName,
    senderAvatarUrl: input.senderAvatarUrl,
    senderNodeDomain: input.senderHomeDomain,
    senderDid: input.senderDid,
    content: null,
    protocolVersion: E2EE_PROTOCOL_VERSION,
    clientMessageId: input.envelope.messageId,
    encryptedEnvelope: JSON.stringify(input.envelope),
    e2eeSignature: input.signedAction.sig,
    e2eeActionNonce: input.signedAction.nonce,
    e2eeActionTs: input.signedAction.ts,
    deliveredAt: new Date(),
    readAt: input.readAt,
    createdAt: input.createdAt,
  };
}

export async function POST(request: NextRequest) {
  try {
    const signedAction = signedUserActionSchema.parse(await request.json()) as SignedAction;
    const user = await requireSignedAction(signedAction);
    const envelope = e2eeMessageEnvelopeSchema.parse(signedAction.data);
    validateMessageBindings(envelope, signedAction);
    validateCiphertextLengths(envelope);

    const senderAddress = parseAccountAddress(envelope.senderHandle);
    const recipientAddress = parseAccountAddress(envelope.recipientHandle);
    if (!senderAddress || senderAddress.canonical !== envelope.senderHandle
      || !recipientAddress || recipientAddress.canonical !== envelope.recipientHandle) {
      return NextResponse.json({ error: 'Encrypted messages require canonical account addresses' }, { status: 400 });
    }

    if (envelope.senderDid !== user.did
      || envelope.senderHandle !== user.handle
      || senderAddress.username !== user.username
      || senderAddress.homeDomain !== user.homeDomain
      || !user.isLocalAccount) {
      return NextResponse.json({ error: 'Sender identity mismatch' }, { status: 403 });
    }

    const [senderKey, senderVault] = await Promise.all([
      db.query.e2eeKeyBundles.findFirst({ where: { userId: user.id } }),
      db.query.e2eeKeyVaults.findFirst({ where: { userId: user.id } }),
    ]);
    if (!senderKey || !senderVault
      || senderKey.keyId !== senderVault.keyId
      || senderKey.keyVersion !== senderVault.keyVersion
      || senderKey.publicKey !== senderVault.publicKey
      || senderVault.ownerDid !== user.did
      || senderKey.keyId !== envelope.senderKeyId
      || senderKey.keyVersion !== envelope.senderKeyVersion) {
      return NextResponse.json({
        error: senderKey && !senderVault
          ? 'Finish encrypted message setup on this node before sending'
          : 'Your encrypted message key changed. Reload Chat and try again.',
        code: 'E2EE_SENDER_KEY_STALE',
      }, { status: 409 });
    }

    const recipientUser = await db.query.users.findFirst({ where: { did: envelope.recipientDid } });
    const isRemoteRecipient = !recipientUser || !recipientUser.isLocalAccount;
    const createdAt = new Date(envelope.createdAt);

    if (recipientUser && !isRemoteRecipient) {
      if (recipientUser.id === user.id) {
        return NextResponse.json({ error: 'Cannot send an encrypted DM to yourself' }, { status: 400 });
      }
      if (envelope.recipientHandle.toLowerCase() !== recipientUser.handle.toLowerCase()) {
        return NextResponse.json({ error: 'Recipient identity mismatch' }, { status: 403 });
      }
      if (recipientUser.dmPrivacy === 'none') {
        return NextResponse.json({ error: 'This user does not accept direct messages' }, { status: 403 });
      }
      if (recipientUser.dmPrivacy === 'following') {
        const followsSender = await db.query.follows.findFirst({
          where: { AND: [{ followerId: recipientUser.id }, { followingId: user.id }] },
        });
        if (!followsSender) {
          return NextResponse.json({ error: 'This user only accepts messages from accounts they follow' }, { status: 403 });
        }
      }
      const [recipientBlockedSender, senderBlockedRecipient] = await Promise.all([
        db.query.blocks.findFirst({
          where: { AND: [{ userId: recipientUser.id }, { blockedUserId: user.id }] },
        }),
        db.query.blocks.findFirst({
          where: { AND: [{ userId: user.id }, { blockedUserId: recipientUser.id }] },
        }),
      ]);
      if (recipientBlockedSender || senderBlockedRecipient) {
        return NextResponse.json({ error: 'Message not permitted' }, { status: 403 });
      }

      const [recipientKey, recipientVault] = await Promise.all([
        db.query.e2eeKeyBundles.findFirst({ where: { userId: recipientUser.id } }),
        db.query.e2eeKeyVaults.findFirst({ where: { userId: recipientUser.id } }),
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
        || recipientVault.ownerDid !== recipientUser.did
        || recipientKey.keyId !== envelope.recipientKeyId
        || recipientKey.keyVersion !== envelope.recipientKeyVersion) {
        return NextResponse.json({
          error: 'Recipient encryption key changed. Reload Chat and try again.',
          code: 'E2EE_RECIPIENT_KEY_STALE',
        }, { status: 409 });
      }

      await db.transaction(async (tx) => {
        const [recipientReceipt] = await tx.insert(e2eeMessageReceipts).values({
          ownerUserId: recipientUser.id,
          senderDid: user.did,
          messageId: envelope.messageId,
        }).onConflictDoNothing().returning({ id: e2eeMessageReceipts.id });
        if (!recipientReceipt) return;

        const [senderReceipt] = await tx.insert(e2eeMessageReceipts).values({
          ownerUserId: user.id,
          senderDid: user.did,
          messageId: envelope.messageId,
        }).onConflictDoNothing().returning({ id: e2eeMessageReceipts.id });
        if (!senderReceipt) throw new Error('Encrypted message receipt state is inconsistent');

        let [recipientConversation] = await tx.select().from(chatConversations).where(and(
          eq(chatConversations.participant1Id, recipientUser.id),
          eq(chatConversations.participant2Handle, user.handle),
        )).limit(1);
        if (!recipientConversation) {
          [recipientConversation] = await tx.insert(chatConversations).values({
            participant1Id: recipientUser.id,
            participant2Handle: user.handle,
            lastMessageAt: createdAt,
            lastMessagePreview: 'Encrypted message',
            encryptionMode: 'e2ee',
            e2eeActivatedAt: createdAt,
          }).returning();
        } else {
          await tx.update(chatConversations).set({
            lastMessageAt: recipientConversation.lastMessageAt && recipientConversation.lastMessageAt > createdAt
              ? recipientConversation.lastMessageAt
              : createdAt,
            lastMessagePreview: 'Encrypted message',
            encryptionMode: 'e2ee',
            e2eeActivatedAt: recipientConversation.e2eeActivatedAt ?? createdAt,
            updatedAt: new Date(),
          }).where(eq(chatConversations.id, recipientConversation.id));
        }

        let [senderConversation] = await tx.select().from(chatConversations).where(and(
          eq(chatConversations.participant1Id, user.id),
          eq(chatConversations.participant2Handle, recipientUser.handle),
        )).limit(1);
        if (!senderConversation) {
          [senderConversation] = await tx.insert(chatConversations).values({
            participant1Id: user.id,
            participant2Handle: recipientUser.handle,
            lastMessageAt: createdAt,
            lastMessagePreview: 'Encrypted message',
            encryptionMode: 'e2ee',
            e2eeActivatedAt: createdAt,
          }).returning();
        } else {
          await tx.update(chatConversations).set({
            lastMessageAt: senderConversation.lastMessageAt && senderConversation.lastMessageAt > createdAt
              ? senderConversation.lastMessageAt
              : createdAt,
            lastMessagePreview: 'Encrypted message',
            encryptionMode: 'e2ee',
            e2eeActivatedAt: senderConversation.e2eeActivatedAt ?? createdAt,
            updatedAt: new Date(),
          }).where(eq(chatConversations.id, senderConversation.id));
        }

        if (!recipientConversation || !senderConversation) {
          throw new Error('Failed to create encrypted conversations');
        }
        const [recipientMessage] = await tx.insert(chatMessages).values(messageValues({
          conversationId: recipientConversation.id,
          senderHandle: user.handle,
          senderDisplayName: user.displayName,
          senderAvatarUrl: user.avatarUrl,
          senderDid: user.did,
          senderHomeDomain: user.homeDomain,
          envelope,
          signedAction,
          createdAt,
        })).returning({ id: chatMessages.id });
        if (!recipientMessage) throw new Error('Failed to store the recipient message');

        await tx.insert(chatMessages).values(messageValues({
          conversationId: senderConversation.id,
          senderHandle: user.handle,
          senderDisplayName: user.displayName,
          senderAvatarUrl: user.avatarUrl,
          senderDid: user.did,
          senderHomeDomain: user.homeDomain,
          envelope,
          signedAction,
          createdAt,
          readAt: new Date(),
        }));
        await enqueueMessagePushDeliveries(tx, recipientUser.id, recipientMessage.id);
      });

      return NextResponse.json({ success: true, messageId: envelope.messageId });
    }

    const cachedRecipientKey = await db.query.e2eeRemoteKeyBundles.findFirst({
      where: { did: envelope.recipientDid },
    });
    if (!cachedRecipientKey || cachedRecipientKey.keyId !== envelope.recipientKeyId
      || cachedRecipientKey.keyVersion !== envelope.recipientKeyVersion) {
      return NextResponse.json({
        error: 'Recipient encryption key must be verified again',
        code: 'E2EE_RECIPIENT_KEY_STALE',
      }, { status: 409 });
    }
    if (cachedRecipientKey.handle !== recipientAddress.canonical) {
      return NextResponse.json({ error: 'Recipient identity mismatch' }, { status: 403 });
    }
    if (recipientUser) {
      const senderBlockedRecipient = await db.query.blocks.findFirst({
        where: { AND: [{ userId: user.id }, { blockedUserId: recipientUser.id }] },
      });
      if (senderBlockedRecipient) {
        return NextResponse.json({ error: 'Message not permitted' }, { status: 403 });
      }
    }

    const fullRecipientHandle = recipientAddress.canonical;
    let targetDomain: string | null = recipientAddress.homeDomain;
    const registryEntry = await db.query.handleRegistry.findFirst({
      where: { handle: fullRecipientHandle },
    });
    if (!registryEntry
      || registryEntry.deletedAt
      || !registryEntry.identityVerified
      || registryEntry.did !== envelope.recipientDid
      || normalizeNodeDomain(registryEntry.nodeDomain) !== targetDomain) {
      return NextResponse.json({
        error: 'Recipient identity does not match the verified handle',
        code: 'E2EE_IDENTITY_KEY_CHANGED',
      }, { status: 409 });
    }
    const normalizedTargetDomain = normalizeNodeDomain(targetDomain);
    const isDevelopmentLoopback = process.env.NODE_ENV === 'development'
      && /^localhost(?::\d{1,5})?$/i.test(normalizedTargetDomain);
    targetDomain = isDevelopmentLoopback
      ? normalizedTargetDomain
      : getPublicSwarmDomain(normalizedTargetDomain);
    if (!targetDomain) {
      return NextResponse.json({ error: 'Recipient node domain is invalid' }, { status: 400 });
    }
    if (await isNodeBlocked(targetDomain)) {
      return NextResponse.json({ error: 'Recipient node is blocked' }, { status: 403 });
    }

    const protocol = isDevelopmentLoopback ? 'http' : 'https';
    let federation: ReturnType<typeof createFederationActionContext>;
    try {
      federation = createFederationActionContext({
        destinationDomain: targetDomain,
        method: 'POST',
        path: '/api/chat/receive',
      });
    } catch {
      return NextResponse.json({ error: 'This node is not configured for federated messages' }, { status: 503 });
    }
    const federatedPayload = {
      federation,
      userAction: signedAction,
      fullSenderHandle: user.handle,
      deliveryId: `${envelope.messageId}:${federation.destinationDomain}`,
    };
    const { payload, signature } = await createSignedPayload(federatedPayload);
    const remoteResponse = await safeFederationRequest(`${protocol}://${targetDomain}/api/chat/receive`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Swarm-Source-Domain': federation.sourceDomain,
        'X-Swarm-Signature': signature,
      },
      body: JSON.stringify(payload),
      maxResponseBytes: 64 * 1024,
    });
    if (remoteResponse.status < 200 || remoteResponse.status >= 300) {
      let remoteBody: { error?: string; code?: string } | null = null;
      try {
        remoteBody = remoteResponse.json() as { error?: string; code?: string };
      } catch {
        // Preserve a generic delivery error for non-JSON remote failures.
      }
      return NextResponse.json({
        error: remoteBody?.error || 'Recipient node rejected the encrypted message',
        code: remoteBody?.code || 'E2EE_REMOTE_DELIVERY_FAILED',
      }, { status: remoteResponse.status === 426 ? 409 : 502 });
    }

    await db.transaction(async (tx) => {
      const [receipt] = await tx.insert(e2eeMessageReceipts).values({
        ownerUserId: user.id,
        senderDid: user.did,
        messageId: envelope.messageId,
      }).onConflictDoNothing().returning({ id: e2eeMessageReceipts.id });
      if (!receipt) return;

      let [senderConversation] = await tx.select().from(chatConversations).where(and(
        eq(chatConversations.participant1Id, user.id),
        eq(chatConversations.participant2Handle, envelope.recipientHandle),
      )).limit(1);
      if (!senderConversation) {
        [senderConversation] = await tx.insert(chatConversations).values({
          participant1Id: user.id,
          participant2Handle: envelope.recipientHandle,
          lastMessageAt: createdAt,
          lastMessagePreview: 'Encrypted message',
          encryptionMode: 'e2ee',
          e2eeActivatedAt: createdAt,
        }).returning();
      } else {
        await tx.update(chatConversations).set({
          lastMessageAt: senderConversation.lastMessageAt && senderConversation.lastMessageAt > createdAt
            ? senderConversation.lastMessageAt
            : createdAt,
          lastMessagePreview: 'Encrypted message',
          encryptionMode: 'e2ee',
          e2eeActivatedAt: senderConversation.e2eeActivatedAt ?? createdAt,
          updatedAt: new Date(),
        }).where(eq(chatConversations.id, senderConversation.id));
      }
      if (!senderConversation) throw new Error('Failed to create encrypted conversation');

      await tx.insert(chatMessages).values(messageValues({
        conversationId: senderConversation.id,
        senderHandle: user.handle,
        senderDisplayName: user.displayName,
        senderAvatarUrl: user.avatarUrl,
        senderDid: user.did,
        senderHomeDomain: user.homeDomain,
        envelope,
        signedAction,
        createdAt,
        readAt: new Date(),
      }));
    });

    return NextResponse.json({ success: true, messageId: envelope.messageId });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({
        error: 'This client must send an encrypted message envelope',
        code: 'E2EE_REQUIRED',
        details: error.issues,
      }, { status: 426 });
    }
    if (error instanceof SignedActionError) {
      const rateLimited = error.message === 'RATE_LIMITED';
      return NextResponse.json({
        error: rateLimited ? 'Too many encrypted messages; try again shortly' : 'Message signature was rejected',
        code: rateLimited ? 'E2EE_RATE_LIMITED' : 'E2EE_SIGNATURE_REJECTED',
      }, { status: rateLimited ? 429 : 403 });
    }
    console.error('[E2EE Chat] Send failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Send failed' }, { status: 500 });
  }
}
