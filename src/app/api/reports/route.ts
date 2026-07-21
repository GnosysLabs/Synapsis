import { NextResponse } from 'next/server';
import { db, reports } from '@/db';
import { requireSignedAction, SignedActionError } from '@/lib/auth/verify-signature';
import { parseAccountAddress } from '@/lib/identity/account-address';
import { z } from 'zod';

const reasonSchema = z.string().trim().min(3).max(500);
const reportSchema = z.discriminatedUnion('targetType', [
    z.object({
        targetType: z.literal('post'),
        targetId: z.string().uuid(),
        reason: reasonSchema,
    }),
    z.object({
        targetType: z.literal('user'),
        // Local users use their UUID. Remote users use a canonical account
        // address because their profile ID is synthetic and only view-local.
        targetId: z.string().trim().min(1).max(320),
        reason: reasonSchema,
    }),
]);

const uuidSchema = z.string().uuid();

export async function POST(request: Request) {
    try {
        const signedAction = await request.json();
        const reporter = await requireSignedAction(signedAction, 'report');

        // Trust signed payload
        const data = reportSchema.parse(signedAction.data);
        let storedTargetId = data.targetId;

        if (data.targetType === 'post') {
            const targetPost = await db.query.posts.findFirst({
                where: { id: data.targetId },
            });
            if (!targetPost || targetPost.isRemoved) {
                return NextResponse.json({ error: 'Post not found' }, { status: 404 });
            }
        }

        if (data.targetType === 'user') {
            const isLocalId = uuidSchema.safeParse(data.targetId).success;
            const targetAddress = isLocalId ? null : parseAccountAddress(data.targetId);

            if (!isLocalId && !targetAddress) {
                return NextResponse.json({ error: 'Invalid user target' }, { status: 400 });
            }

            const targetUser = await db.query.users.findFirst({
                where: isLocalId
                    ? { id: data.targetId }
                    : { handle: targetAddress!.canonical },
            });

            if (targetUser) {
                storedTargetId = targetUser.isLocalAccount
                    ? targetUser.id
                    : targetUser.handle;
            } else if (isLocalId) {
                return NextResponse.json({ error: 'User not found' }, { status: 404 });
            } else {
                // The remote profile was verified when it was rendered. Keep the
                // canonical address even if the identity is not durably cached.
                storedTargetId = targetAddress!.canonical;
            }
        }

        const [report] = await db.insert(reports).values({
            reporterId: reporter.id,
            targetType: data.targetType,
            targetId: storedTargetId,
            reason: data.reason,
            status: 'open',
        }).returning();

        return NextResponse.json({ report });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return NextResponse.json({ error: 'Invalid input', details: error.issues }, { status: 400 });
        }
        if (error instanceof SignedActionError) {
            const rateLimited = error.code === 'RATE_LIMITED';
            return NextResponse.json({
                error: rateLimited
                    ? 'Too many reports submitted. Please wait and try again.'
                    : 'Your identity could not be verified. Please log in again.',
                code: error.code,
            }, { status: rateLimited ? 429 : 403 });
        }
        if (error instanceof Error && error.message === 'Authentication required') {
            return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
        }
        console.error('Report error:', error);
        return NextResponse.json({ error: 'Failed to submit report' }, { status: 500 });
    }
}
