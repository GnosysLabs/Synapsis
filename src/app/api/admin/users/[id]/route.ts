import { NextResponse } from 'next/server';
import { db, users } from '@/db';
import { requireAdmin } from '@/lib/auth/admin';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

type RouteContext = { params: Promise<{ id: string }> };

const moderationSchema = z.object({
    action: z.enum(['suspend', 'unsuspend', 'silence', 'unsilence']),
    reason: z.string().max(240).optional(),
});

export async function PATCH(request: Request, context: RouteContext) {
    try {
        const admin = await requireAdmin();

        if (!db) {
            return NextResponse.json({ error: 'Database not available' }, { status: 503 });
        }

        const { id } = await context.params;
        const body = await request.json();
        const data = moderationSchema.parse(body);

        const user = await db.query.users.findFirst({
            where: { id: id },
        });

        if (!user) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }
        if (user.id === admin.id && (data.action === 'suspend' || data.action === 'silence')) {
            return NextResponse.json({ error: 'Cannot apply this action to yourself' }, { status: 400 });
        }

        if (data.action === 'suspend') {
            const [updated] = await db.update(users)
                .set({
                    isSuspended: true,
                    suspendedAt: new Date(),
                    suspensionReason: data.reason || null,
                })
                .where(eq(users.id, id))
                .returning();
            return NextResponse.json({ user: {
                id: updated.id,
                handle: updated.handle,
                displayName: updated.displayName,
                email: updated.email,
                isSuspended: updated.isSuspended,
                suspensionReason: updated.suspensionReason,
                isSilenced: updated.isSilenced,
                silenceReason: updated.silenceReason,
                createdAt: updated.createdAt,
            } });
        }

        if (data.action === 'unsuspend') {
            const [updated] = await db.update(users)
                .set({
                    isSuspended: false,
                    suspendedAt: null,
                    suspensionReason: null,
                })
                .where(eq(users.id, id))
                .returning();
            return NextResponse.json({ user: {
                id: updated.id,
                handle: updated.handle,
                displayName: updated.displayName,
                email: updated.email,
                isSuspended: updated.isSuspended,
                suspensionReason: updated.suspensionReason,
                isSilenced: updated.isSilenced,
                silenceReason: updated.silenceReason,
                createdAt: updated.createdAt,
            } });
        }

        if (data.action === 'silence') {
            const [updated] = await db.update(users)
                .set({
                    isSilenced: true,
                    silencedAt: new Date(),
                    silenceReason: data.reason || null,
                })
                .where(eq(users.id, id))
                .returning();
            return NextResponse.json({ user: {
                id: updated.id,
                handle: updated.handle,
                displayName: updated.displayName,
                email: updated.email,
                isSuspended: updated.isSuspended,
                suspensionReason: updated.suspensionReason,
                isSilenced: updated.isSilenced,
                silenceReason: updated.silenceReason,
                createdAt: updated.createdAt,
            } });
        }

        const [updated] = await db.update(users)
            .set({
                isSilenced: false,
                silencedAt: null,
                silenceReason: null,
            })
            .where(eq(users.id, id))
            .returning();

        return NextResponse.json({ user: {
            id: updated.id,
            handle: updated.handle,
            displayName: updated.displayName,
            email: updated.email,
            isSuspended: updated.isSuspended,
            suspensionReason: updated.suspensionReason,
            isSilenced: updated.isSilenced,
            silenceReason: updated.silenceReason,
            createdAt: updated.createdAt,
        } });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return NextResponse.json({ error: 'Invalid input', details: error.issues }, { status: 400 });
        }
        if (error instanceof Error && error.message === 'Admin required') {
            return NextResponse.json({ error: 'Admin required' }, { status: 403 });
        }
        console.error('Admin user moderation error:', error);
        return NextResponse.json({ error: 'Failed to update user' }, { status: 500 });
    }
}
