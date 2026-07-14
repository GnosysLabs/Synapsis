import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users, blocks, follows } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth';

type RouteContext = { params: Promise<{ handle: string }> };

// GET - Check if blocked
export async function GET(req: NextRequest, context: RouteContext) {
    try {
        const currentUser = await requireAuth();
        const { handle } = await context.params;

        const targetUser = await db.query.users.findFirst({
            where: { handle: handle },
        });

        if (!targetUser) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        const block = await db.query.blocks.findFirst({
            where: { AND: [{ userId: currentUser.id }, { blockedUserId: targetUser.id }] },
        });

        return NextResponse.json({ blocked: !!block });
    } catch (error) {
        if (error instanceof Error && error.message === 'Unauthorized') {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        console.error('Check block error:', error);
        return NextResponse.json({ error: 'Failed to check block status' }, { status: 500 });
    }
}

// POST - Block user
export async function POST(req: NextRequest, context: RouteContext) {
    try {
        const currentUser = await requireAuth();
        const { handle } = await context.params;

        const targetUser = await db.query.users.findFirst({
            where: { handle: handle },
        });

        if (!targetUser) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        if (targetUser.id === currentUser.id) {
            return NextResponse.json({ error: 'Cannot block yourself' }, { status: 400 });
        }

        // Check if already blocked
        const existing = await db.query.blocks.findFirst({
            where: { AND: [{ userId: currentUser.id }, { blockedUserId: targetUser.id }] },
        });

        if (existing) {
            return NextResponse.json({ blocked: true });
        }

        // Create block
        await db.insert(blocks).values({
            userId: currentUser.id,
            blockedUserId: targetUser.id,
        });

        // Remove any follows between the users
        await db.delete(follows).where(
            and(
                eq(follows.followerId, currentUser.id),
                eq(follows.followingId, targetUser.id)
            )
        );
        await db.delete(follows).where(
            and(
                eq(follows.followerId, targetUser.id),
                eq(follows.followingId, currentUser.id)
            )
        );

        return NextResponse.json({ blocked: true });
    } catch (error) {
        if (error instanceof Error && error.message === 'Unauthorized') {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        console.error('Block user error:', error);
        return NextResponse.json({ error: 'Failed to block user' }, { status: 500 });
    }
}

// DELETE - Unblock user
export async function DELETE(req: NextRequest, context: RouteContext) {
    try {
        const currentUser = await requireAuth();
        const { handle } = await context.params;

        const targetUser = await db.query.users.findFirst({
            where: { handle: handle },
        });

        if (!targetUser) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        await db.delete(blocks).where(
            and(
                eq(blocks.userId, currentUser.id),
                eq(blocks.blockedUserId, targetUser.id)
            )
        );

        return NextResponse.json({ blocked: false });
    } catch (error) {
        if (error instanceof Error && error.message === 'Unauthorized') {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        console.error('Unblock user error:', error);
        return NextResponse.json({ error: 'Failed to unblock user' }, { status: 500 });
    }
}
