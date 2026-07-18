/**
 * Account Moved Notification API
 * 
 * Called by the new node to notify the old node that an account has migrated.
 * The old node then marks the account as moved.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, users } from '@/db';
import { eq } from 'drizzle-orm';
import * as crypto from 'crypto';
import { z } from 'zod';

import { FederationRequestBodyError, readLimitedJson } from '@/lib/swarm/request-body';
import { federationWebUrlSchema, localHandleSchema } from '@/lib/utils/federation';

const MAX_MOVE_NOTIFICATION_BYTES = 32 * 1024;
const MOVE_NOTIFICATION_MAX_AGE_MS = 10 * 60 * 1_000;
const moveNotificationSchema = z.strictObject({
    oldHandle: localHandleSchema,
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
        const oldHandle = body.oldHandle.toLowerCase();
        const movedAtMs = Date.parse(movedAt);
        if (!Number.isFinite(movedAtMs)
            || Math.abs(Date.now() - movedAtMs) > MOVE_NOTIFICATION_MAX_AGE_MS) {
            return NextResponse.json({ error: 'Move notification is stale' }, { status: 400 });
        }

        // Find the user on this node
        const user = await db.query.users.findFirst({
            where: { handle: oldHandle.toLowerCase() },
        });

        if (!user) {
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

        // Check if already moved
        if (user.movedTo) {
            return NextResponse.json({ error: 'Account already marked as moved' }, { status: 409 });
        }

        // Mark the account as moved
        await db.update(users)
            .set({
                movedTo: newActorUrl,
                migratedAt: new Date(movedAtMs),
                updatedAt: new Date(),
            })
            .where(eq(users.id, user.id));

        // Get all followers to notify
        const userFollowers = await db.query.follows.findMany({
            where: { followingId: user.id },
            with: {
                follower: true,
            },
        });

        console.log(`Account ${oldHandle} marked as moved to ${newActorUrl}. ${userFollowers.length} followers.`);

        return NextResponse.json({
            success: true,
            message: 'Account marked as moved',
            followersNotified: userFollowers.length,
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
