import { NextResponse } from 'next/server';
import { db, users, posts, sessions, likes, follows, notifications, chatMessages, chatConversations } from '@/db';
import { eq, or } from 'drizzle-orm';
import { requireSignedAction, type SignedAction } from '@/lib/auth/verify-signature';
import { verifyPassword } from '@/lib/auth';
import { cookies } from 'next/headers';

export async function POST(request: Request) {
    try {
        const signedAction: SignedAction = await request.json();

        // Verify signature and get user
        const user = await requireSignedAction(signedAction);

        if (signedAction.action !== 'delete_account') {
            return NextResponse.json(
                { error: 'Invalid action type' },
                { status: 400 }
            );
        }

        const { password } = signedAction.data;

        // Verify password
        if (!user.passwordHash) {
            return NextResponse.json(
                { error: 'Account has no password set' },
                { status: 400 }
            );
        }

        const isPasswordValid = await verifyPassword(password, user.passwordHash);
        
        if (!isPasswordValid) {
            return NextResponse.json(
                { error: 'Password is incorrect' },
                { status: 403 }
            );
        }

        const userId = user.id;
        const userDid = user.did;

        // Delete all user data in proper order to respect foreign keys
        
        // 1. Delete chat messages sent by this user
        await db.delete(chatMessages)
            .where(eq(chatMessages.senderDid, userDid));

        // 2. Find and delete conversations where user is a participant
        // First get conversation IDs where user is participant1 (local user)
        // For participant2, we need to check by handle since it's stored as text (can be remote)
        const conversations = await db.query.chatConversations.findMany({
            where: { OR: [{ participant1Id: userId }, { participant2Handle: user.handle }] },
        });

        const conversationIds = conversations.map(c => c.id);

        // Delete messages in those conversations
        if (conversationIds.length > 0) {
            for (const convId of conversationIds) {
                await db.delete(chatMessages)
                    .where(eq(chatMessages.conversationId, convId));
            }
        }

        // 3. Delete the conversations themselves
        if (conversationIds.length > 0) {
            for (const convId of conversationIds) {
                await db.delete(chatConversations)
                    .where(eq(chatConversations.id, convId));
            }
        }

        // 4. Delete notifications
        await db.delete(notifications)
            .where(or(
                eq(notifications.userId, userId),
                eq(notifications.actorId, userId)
            ));

        // 5. Delete likes
        await db.delete(likes)
            .where(eq(likes.userId, userId));

        // 6. Delete follows (both directions)
        await db.delete(follows)
            .where(or(
                eq(follows.followerId, userId),
                eq(follows.followingId, userId)
            ));

        // 7. Delete posts (this will cascade delete reposts and post likes via triggers if set up)
        await db.delete(posts)
            .where(eq(posts.userId, userId));

        // 8. Delete sessions
        await db.delete(sessions)
            .where(eq(sessions.userId, userId));

        // 9. Finally, delete the user
        await db.delete(users)
            .where(eq(users.id, userId));

        // Clear session cookie
        const cookieStore = await cookies();
        cookieStore.delete('synapsis_session');

        return NextResponse.json({
            success: true,
            message: 'Account deleted successfully',
        });

    } catch (error) {
        console.error('Account deletion error:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Failed to delete account' },
            { status: 500 }
        );
    }
}
