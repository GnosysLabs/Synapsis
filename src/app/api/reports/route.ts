import { NextResponse } from 'next/server';
import { db, reports } from '@/db';
import { requireSignedAction } from '@/lib/auth/verify-signature';
import { z } from 'zod';

const reportSchema = z.object({
    targetType: z.enum(['post', 'user']),
    targetId: z.string().uuid(),
    reason: z.string().min(3).max(500),
});

export async function POST(request: Request) {
    try {
        const signedAction = await request.json();
        const reporter = await requireSignedAction(signedAction);

        // Trust signed payload
        const data = reportSchema.parse(signedAction.data);

        if (data.targetType === 'post') {
            const targetPost = await db.query.posts.findFirst({
                where: { id: data.targetId },
            });
            if (!targetPost || targetPost.isRemoved) {
                return NextResponse.json({ error: 'Post not found' }, { status: 404 });
            }
        }

        if (data.targetType === 'user') {
            const targetUser = await db.query.users.findFirst({
                where: { id: data.targetId },
            });
            if (!targetUser) {
                return NextResponse.json({ error: 'User not found' }, { status: 404 });
            }
        }

        const [report] = await db.insert(reports).values({
            reporterId: reporter.id,
            targetType: data.targetType,
            targetId: data.targetId,
            reason: data.reason,
            status: 'open',
        }).returning();

        return NextResponse.json({ report });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return NextResponse.json({ error: 'Invalid input', details: error.issues }, { status: 400 });
        }
        if (error instanceof Error && error.message === 'Authentication required') {
            return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
        }
        console.error('Report error:', error);
        return NextResponse.json({ error: 'Failed to submit report' }, { status: 500 });
    }
}
