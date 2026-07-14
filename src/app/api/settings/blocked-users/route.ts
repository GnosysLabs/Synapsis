import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { blocks, users } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth';

// GET - List blocked users
export async function GET() {
    try {
        const currentUser = await requireAuth();

        const blocked = await db.query.blocks.findMany({
            where: { userId: currentUser.id },
            with: {
                blockedUser: true,
            },
            orderBy: (t, { desc }) => [desc(t.createdAt)],
        });

        return NextResponse.json({
            blockedUsers: blocked.map(b => ({
                id: b.blockedUser.id,
                handle: b.blockedUser.handle,
                displayName: b.blockedUser.displayName,
                avatarUrl: b.blockedUser.avatarUrl,
                blockedAt: b.createdAt.toISOString(),
            })),
        });
    } catch (error) {
        if (error instanceof Error && error.message === 'Unauthorized') {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        console.error('Get blocked users error:', error);
        return NextResponse.json({ error: 'Failed to get blocked users' }, { status: 500 });
    }
}

// DELETE - Unblock a user by ID
export async function DELETE(req: NextRequest) {
    try {
        const currentUser = await requireAuth();
        const { searchParams } = new URL(req.url);
        const userId = searchParams.get('userId');

        if (!userId) {
            return NextResponse.json({ error: 'User ID is required' }, { status: 400 });
        }

        await db.delete(blocks).where(
            and(
                eq(blocks.userId, currentUser.id),
                eq(blocks.blockedUserId, userId)
            )
        );

        return NextResponse.json({ unblocked: true });
    } catch (error) {
        if (error instanceof Error && error.message === 'Unauthorized') {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        console.error('Unblock user error:', error);
        return NextResponse.json({ error: 'Failed to unblock user' }, { status: 500 });
    }
}
