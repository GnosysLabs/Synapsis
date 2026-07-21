/**
 * Account Moved Notification API
 * 
 * Called by the new node to notify the old node that an account has migrated.
 * The old node then replaces the account with a permanent move tombstone.
 */

import { NextRequest, NextResponse } from 'next/server';
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
import * as crypto from 'crypto';
import { z } from 'zod';

import { FederationRequestBodyError, readLimitedJson } from '@/lib/swarm/request-body';
import { federationWebUrlSchema } from '@/lib/utils/federation';
import {
    requireCanonicalAccountHomeDomain,
    resolveAccountAddress,
} from '@/lib/identity/account-address';

const MAX_MOVE_NOTIFICATION_BYTES = 32 * 1024;
const MOVE_NOTIFICATION_MAX_FUTURE_SKEW_MS = 10 * 60 * 1_000;
const moveNotificationSchema = z.strictObject({
    // Bare values are accepted only for legacy, already-signed move notices;
    // the receiving node supplies the authoritative local domain.
    oldHandle: z.string().min(1).max(320),
    newActorUrl: federationWebUrlSchema,
    did: z.string().min(16).max(2_048),
    movedAt: z.string().datetime(),
    signature: z.string().min(1).max(16_384).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

export async function POST(req: NextRequest) {
    try {
        const body = moveNotificationSchema.parse(await readLimitedJson(
            req,
            MAX_MOVE_NOTIFICATION_BYTES,
        ));
        const { newActorUrl, did, movedAt, signature } = body;
        const localDomain = requireCanonicalAccountHomeDomain(
            process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
        );
        const oldAddress = resolveAccountAddress(body.oldHandle, localDomain);
        if (!oldAddress || oldAddress.homeDomain !== localDomain) {
            return NextResponse.json({ error: 'Move notification targets another node' }, { status: 400 });
        }
        const movedAtMs = Date.parse(movedAt);
        if (!Number.isFinite(movedAtMs)
            || movedAtMs > Date.now() + MOVE_NOTIFICATION_MAX_FUTURE_SKEW_MS) {
            return NextResponse.json({ error: 'Move notification timestamp is invalid' }, { status: 400 });
        }

        // Find the user on this node
        const user = await db.query.users.findFirst({
            where: {
                AND: [
                    { username: oldAddress.username },
                    { homeDomain: localDomain },
                    { isLocalAccount: true },
                ],
            },
        });

        if (!user) {
            const tombstone = await db.query.swarmAccountTombstones.findFirst({
                where: { handle: oldAddress.canonical },
            });
            if (tombstone?.did === did && tombstone.movedTo === newActorUrl) {
                return NextResponse.json({
                    success: true,
                    message: 'Account move was already finalized',
                    sourceDataDeleted: true,
                    usernameReserved: true,
                });
            }
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        // Verify the DID matches
        if (user.did !== did) {
            return NextResponse.json({ error: 'DID mismatch' }, { status: 403 });
        }

        // Verify the signature using the user's public key
        const payload = { oldHandle: body.oldHandle, newActorUrl, did, movedAt };
        const verify = crypto.createVerify('sha256');
        verify.update(JSON.stringify(payload));

        const isValid = verify.verify(user.publicKey, signature, 'base64');
        if (!isValid) {
            return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
        }

        // Count local follower relationships before the account is removed.
        const userFollowers = await db.query.follows.findMany({
            where: { followingId: user.id },
        });

        // Preserve only the cryptographically-bound move target and permanent
        // username reservation. All user-owned rows and credentials are
        // removed in the same transaction as the move tombstone.
        await db.transaction(async (tx) => {
            await tx.delete(chatMessages).where(eq(chatMessages.senderDid, user.did));

            const conversations = await tx.query.chatConversations.findMany({
                where: {
                    OR: [
                        { participant1Id: user.id },
                        { participant2Handle: user.handle },
                        { participant2Handle: user.username },
                    ],
                },
            });
            for (const conversation of conversations) {
                await tx.delete(chatConversations).where(eq(chatConversations.id, conversation.id));
            }

            await tx.delete(notifications).where(or(
                eq(notifications.userId, user.id),
                eq(notifications.actorId, user.id),
            ));
            await tx.delete(likes).where(eq(likes.userId, user.id));
            await tx.delete(follows).where(or(
                eq(follows.followerId, user.id),
                eq(follows.followingId, user.id),
            ));
            await tx.update(posts).set({ removedBy: null }).where(eq(posts.removedBy, user.id));
            await tx.update(reports).set({ resolvedBy: null }).where(eq(reports.resolvedBy, user.id));
            await tx.delete(posts).where(eq(posts.userId, user.id));
            await tx.delete(sessions).where(eq(sessions.userId, user.id));

            const [clock] = await tx.update(swarmContentClock).set({
                sequence: sql`${swarmContentClock.sequence} + 1`,
            }).where(eq(swarmContentClock.id, 1)).returning({
                sequence: swarmContentClock.sequence,
            });
            if (!clock) throw new Error('Federation change clock is unavailable');

            await tx.insert(swarmAccountTombstones).values({
                handle: oldAddress.canonical,
                username: oldAddress.username,
                homeDomain: oldAddress.homeDomain,
                did: user.did,
                sequence: clock.sequence,
                deletedAt: new Date(movedAtMs),
                movedTo: newActorUrl,
                migratedAt: new Date(movedAtMs),
            });
            await tx.update(handleRegistry).set({
                deletedAt: new Date(movedAtMs),
                updatedAt: new Date(),
            }).where(and(
                eq(handleRegistry.did, user.did),
                eq(handleRegistry.nodeDomain, oldAddress.homeDomain),
            ));
            await tx.delete(users).where(eq(users.id, user.id));
        });

        console.log(`Account ${oldAddress.canonical} moved to ${newActorUrl}; source data deleted and username reserved.`);

        return NextResponse.json({
            success: true,
            message: 'Account move finalized',
            sourceDataDeleted: true,
            usernameReserved: true,
            followerRelationshipsRemoved: userFollowers.length,
        });

    } catch (error) {
        if (error instanceof FederationRequestBodyError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        if (error instanceof z.ZodError) {
            return NextResponse.json({ error: 'Invalid move notification' }, { status: 400 });
        }
        console.error('Move notification error:', error);
        return NextResponse.json({ error: 'Failed to process move notification' }, { status: 500 });
    }
}
