/**
 * Swarm Chat Deletion Inbox
 * 
 * POST: Receives conversation deletion requests from other swarm nodes
 * 
 * Security: Only allows deletion if the sender is actually a participant in the conversation
 * and the request is cryptographically signed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, users, chatConversations } from '@/db';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { verifyUserInteraction } from '@/lib/swarm/signature';
import { isNodeBlocked, normalizeNodeDomain } from '@/lib/swarm/node-blocklist';

const deletionSchema = z.object({
  senderHandle: z.string(),
  senderNodeDomain: z.string(),
  recipientHandle: z.string(),
  conversationId: z.string().optional(),
  timestamp: z.string(),
  signature: z.string(),
});

export async function POST(request: NextRequest) {
  try {
    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    }

    const body = await request.json();
    const data = deletionSchema.parse(body);
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
      where: eq(users.handle, data.recipientHandle.toLowerCase()),
    });

    if (!recipient) {
      return NextResponse.json({ error: 'Recipient not found' }, { status: 404 });
    }

    // Find the conversation with the sender
    const senderFullHandle = `${data.senderHandle}@${senderNodeDomain}`;
    const conversation = await db.query.chatConversations.findFirst({
      where: and(
        eq(chatConversations.participant1Id, recipient.id),
        eq(chatConversations.participant2Handle, senderFullHandle)
      ),
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
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid payload', details: error.issues }, { status: 400 });
    }
    console.error('Swarm chat deletion error:', error);
    return NextResponse.json({ error: 'Failed to process deletion' }, { status: 500 });
  }
}
