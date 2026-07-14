import { NextResponse } from 'next/server';
import { db, posts } from '@/db';
import { requireAdmin } from '@/lib/auth/admin';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

type RouteContext = { params: Promise<{ id: string }> };

const moderationSchema = z.object({
    action: z.enum(['remove', 'restore']),
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

        const post = await db.query.posts.findFirst({
            where: { id: id },
        });

        if (!post) {
            return NextResponse.json({ error: 'Post not found' }, { status: 404 });
        }

        if (data.action === 'remove') {
            const [updated] = await db.update(posts)
                .set({
                    isRemoved: true,
                    removedAt: new Date(),
                    removedBy: admin.id,
                    removedReason: data.reason || null,
                })
                .where(eq(posts.id, id))
                .returning();

            return NextResponse.json({ post: updated });
        }

        const [restored] = await db.update(posts)
            .set({
                isRemoved: false,
                removedAt: null,
                removedBy: null,
                removedReason: null,
            })
            .where(eq(posts.id, id))
            .returning();

        return NextResponse.json({ post: restored });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return NextResponse.json({ error: 'Invalid input', details: error.issues }, { status: 400 });
        }
        if (error instanceof Error && error.message === 'Admin required') {
            return NextResponse.json({ error: 'Admin required' }, { status: 403 });
        }
        console.error('Post moderation error:', error);
        return NextResponse.json({ error: 'Failed to update post' }, { status: 500 });
    }
}
