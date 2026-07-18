/**
 * Swarm Chat Deletion Inbox
 * 
 * POST: Receives conversation deletion requests from other swarm nodes
 * 
 * Security: Only allows deletion if the sender is actually a participant in the conversation
 * and the request is cryptographically signed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, chatConversations } from '@/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { isFreshFederationTimestamp, verifyUserInteraction } from '@/lib/swarm/signature';
import { isNodeBlocked, normalizeNodeDomain } from '@/lib/swarm/node-blocklist';
import { FederationRequestBodyError, readLimitedJson } from '@/lib/swarm/request-body';

const deletionSchema = z.object({
  senderHandle: z.string().min(3).max(30),
  senderNodeDomain: z.string().min(1).max(253),
  recipientHandle: z.string().min(3).max(30),
  conversationId: z.string().uuid().optional(),
  timestamp: z.string().datetime(),
  signature: z.string().min(1).max(16_384),
});

export async function POST(request: NextRequest) {
  try {
    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    }

    const body = await readLimitedJson(request);
    const data = deletionSchema.parse(body);
    if (!isFreshFederationTimestamp(data.timestamp)) {
      return NextResponse.json({ error: 'Stale deletion request' }, { status: 400 });
    }
    const senderNodeDomain = normalizeNodeDomain(data.senderNodeDomain);

    if (await isNodeBlocked(senderNodeDomain)) {
      return NextResponse.json({ error: 'Blocked node' }, { status: 403 });
    }

    // SECURITY: Verify the signature
    const { signature, ...payload } = data;
    const isValid = await verifyUserInteraction(
      payload,
      signature,
      data.senderHandle,
      senderNodeDomain
    );

    if (!isValid) {
      console.warn(`[Swarm Chat Delete] Invalid signature from ${data.senderHandle}@${data.senderNodeDomain}`);
      return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
    }

    // Find the recipient (local user)
    const recipient = await db.query.users.findFirst({
      where: { handle: data.recipientHandle.toLowerCase() },
    });

    if (!recipient) {
      return NextResponse.json({ error: 'Recipient not found' }, { status: 404 });
    }

    // Find the conversation with the sender
    const senderFullHandle = `${data.senderHandle}@${senderNodeDomain}`;
    const conversation = await db.query.chatConversations.findFirst({
      where: { AND: [{ participant1Id: recipient.id }, { participant2Handle: senderFullHandle }] },
    });

    if (!conversation) {
      // Conversation doesn't exist - could be already deleted or never existed
      // Return success to avoid leaking information about conversation existence
      return NextResponse.json({
        success: true,
        message: 'Conversation not found',
      });
    }

    // SECURITY CHECK: Verify the sender is actually a participant in this conversation
    // The conversation must be between the recipient (participant1) and the sender (participant2)
    if (conversation.participant2Handle !== senderFullHandle) {
      console.warn(`[Swarm Chat Delete] Unauthorized deletion attempt from ${senderFullHandle} for conversation with ${conversation.participant2Handle}`);
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    // Delete the conversation (cascade will delete messages)
    await db.delete(chatConversations).where(eq(chatConversations.id, conversation.id));
    
    console.log(`[Swarm Chat Delete] Deleted conversation between ${recipient.handle} and ${senderFullHandle}`);
    
    return NextResponse.json({
      success: true,
      message: 'Conversation deleted',
    });
  } catch (error) {
    if (error instanceof FederationRequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid payload', details: error.issues }, { status: 400 });
    }
    console.error('Swarm chat deletion error:', error);
    return NextResponse.json({ error: 'Failed to process deletion' }, { status: 500 });
  }
}
