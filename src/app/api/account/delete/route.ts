import { NextResponse } from 'next/server';
import {
    chatConversations,
    chatMessages,
    db,
    follows,
    handleRegistry,
    likes,
    notifications,
    posts,
    reports,
    sessions,
    swarmAccountTombstones,
    swarmContentClock,
    users,
} from '@/db';
import { and, eq, or, sql } from 'drizzle-orm';
import { requireSignedAction, type SignedAction } from '@/lib/auth/verify-signature';
import { verifyPassword } from '@/lib/auth';
import { cookies } from 'next/headers';
import { parseAccountAddress } from '@/lib/identity/account-address';

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

        const address = parseAccountAddress(user.handle);
        if (!address
            || address.username !== user.username
            || address.homeDomain !== user.homeDomain
            || !user.isLocalAccount) {
            throw new Error('Account identity is not canonical');
        }

        // The deletion marker, all post tombstones, and all local removal happen
        // in one transaction. A crash can therefore leave either the complete
        // account or the complete deletion, never a half-deleted identity.
        await db.transaction(async (tx) => {
            await tx.delete(chatMessages).where(eq(chatMessages.senderDid, userDid));

            const conversations = await tx.query.chatConversations.findMany({
                where: {
                    OR: [
                        { participant1Id: userId },
                        { participant2Handle: user.handle },
                        // Authoritative local compatibility boundary for
                        // conversations created before canonical addresses.
                        { participant2Handle: user.username },
                    ],
                },
            });
            for (const conversation of conversations) {
                await tx.delete(chatConversations).where(eq(chatConversations.id, conversation.id));
            }

            await tx.delete(notifications).where(or(
                eq(notifications.userId, userId),
                eq(notifications.actorId, userId),
            ));
            await tx.delete(likes).where(eq(likes.userId, userId));
            await tx.delete(follows).where(or(
                eq(follows.followerId, userId),
                eq(follows.followingId, userId),
            ));

            // These two foreign keys intentionally preserve moderation history,
            // so release their nullable moderator reference before deleting the
            // account instead of letting SQLite reject the deletion.
            await tx.update(posts).set({ removedBy: null }).where(eq(posts.removedBy, userId));
            await tx.update(reports).set({ resolvedBy: null }).where(eq(reports.resolvedBy, userId));

            // Delete posts while the author row still exists. The database
            // triggers use that row to emit durable post tombstones.
            await tx.delete(posts).where(eq(posts.userId, userId));
            await tx.delete(sessions).where(eq(sessions.userId, userId));

            const [clock] = await tx.update(swarmContentClock).set({
                sequence: sql`${swarmContentClock.sequence} + 1`,
            }).where(eq(swarmContentClock.id, 1)).returning({
                sequence: swarmContentClock.sequence,
            });
            if (!clock) throw new Error('Federation change clock is unavailable');

            await tx.insert(swarmAccountTombstones).values({
                handle: address.canonical,
                username: address.username,
                homeDomain: address.homeDomain,
                did: userDid,
                sequence: clock.sequence,
                deletedAt: new Date(),
            });
            await tx.update(handleRegistry).set({
                deletedAt: new Date(),
                updatedAt: new Date(),
            }).where(and(
                eq(handleRegistry.did, userDid),
                eq(handleRegistry.nodeDomain, address.homeDomain),
            ));
            await tx.delete(users).where(eq(users.id, userId));
        });

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
