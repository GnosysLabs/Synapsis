/**
 * Swarm Chat Conversation Management
 * 
 * DELETE: Delete a conversation (for self or both parties)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, chatConversations, chatMessages, users } from '@/db';
import { eq, and } from 'drizzle-orm';
import { getSession } from '@/lib/auth';
import { isNodeBlocked, normalizeNodeDomain } from '@/lib/swarm/node-blocklist';
import { z } from 'zod';

// Schema for conversation ID parameter
const conversationIdSchema = z.string().uuid('Invalid conversation ID format');

// Schema for delete query parameter
const deleteQuerySchema = z.object({
  deleteFor: z.enum(['self', 'both']).optional(),
});

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    }

    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    
    // Validate conversation ID
    const idResult = conversationIdSchema.safeParse(id);
    if (!idResult.success) {
      return NextResponse.json({ error: 'Invalid conversation ID', details: idResult.error.issues }, { status: 400 });
    }
    
    const { searchParams } = new URL(request.url);
    const deleteForRaw = searchParams.get('deleteFor'); // 'self' or 'both'
    
    // Validate deleteFor parameter
    const deleteForResult = deleteQuerySchema.safeParse({ deleteFor: deleteForRaw || undefined });
    if (!deleteForResult.success) {
      return NextResponse.json({ error: 'Invalid deleteFor parameter', details: deleteForResult.error.issues }, { status: 400 });
    }
    
    const { deleteFor } = deleteForResult.data;

    // Verify the conversation belongs to this user
    const conversation = await db.query.chatConversations.findFirst({
      where: and(
        eq(chatConversations.id, id),
        eq(chatConversations.participant1Id, session.user.id)
      ),
    });

    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    if (deleteFor === 'both') {
      // Delete the entire conversation and all messages (cascade will handle messages)
      await db.delete(chatConversations).where(eq(chatConversations.id, id));

      // Send deletion request to the other party
      const participant2Handle = conversation.participant2Handle;
      const isRemote = participant2Handle.includes('@');

      if (isRemote) {
        // Extract domain from handle (format: handle@domain)
        const domain = normalizeNodeDomain(participant2Handle.split('@')[1]);
        const handle = participant2Handle.split('@')[0];

        try {
          if (await isNodeBlocked(domain)) {
            return NextResponse.json({ success: true });
          }

          const protocol = domain.includes('localhost') ? 'http' : 'https';
          const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost';

          // SECURITY: Sign the deletion request
          const { signPayload, getNodePrivateKey } = await import('@/lib/swarm/signature');
          const privateKey = await getNodePrivateKey();

          const payload = {
            senderHandle: session.user.handle,
            senderNodeDomain: nodeDomain,
            recipientHandle: handle,
            conversationId: id,
            timestamp: new Date().toISOString(),
          };

          const signature = signPayload(payload, privateKey);

          await fetch(`${protocol}://${domain}/api/swarm/chat/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...payload, signature }),
          });

          console.log(`[Chat Delete] Sent deletion request to ${domain}`);
        } catch (error) {
          console.error('[Chat Delete] Failed to notify remote node:', error);
          // Continue anyway - local deletion succeeded
        }
      } else {
        // Local user - find and delete their conversation too
        const recipientUser = await db.query.users.findFirst({
          where: eq(users.handle, participant2Handle),
        });

        if (recipientUser) {
          // Find their conversation with us
          const recipientConversation = await db.query.chatConversations.findFirst({
            where: and(
              eq(chatConversations.participant1Id, recipientUser.id),
              eq(chatConversations.participant2Handle, session.user.handle)
            ),
          });

          if (recipientConversation) {
            await db.delete(chatConversations).where(eq(chatConversations.id, recipientConversation.id));
            console.log(`[Chat Delete] Deleted conversation for local user ${participant2Handle}`);
          }
        }
      }

      return NextResponse.json({
        success: true,
        message: 'Conversation deleted for both parties'
      });
    } else {
      // Delete for self only - just delete the conversation record
      // The other party will still have their copy
      await db.delete(chatConversations).where(eq(chatConversations.id, id));

      return NextResponse.json({
        success: true,
        message: 'Conversation deleted for you'
      });
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid input', details: error.issues }, { status: 400 });
    }
    console.error('Delete conversation error:', error);
    return NextResponse.json({ error: 'Failed to delete conversation' }, { status: 500 });
  }
}
