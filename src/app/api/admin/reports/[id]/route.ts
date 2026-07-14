import { NextResponse } from 'next/server';
import { db, reports } from '@/db';
import { requireAdmin } from '@/lib/auth/admin';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

type RouteContext = { params: Promise<{ id: string }> };

const updateSchema = z.object({
    status: z.enum(['open', 'resolved']),
    note: z.string().max(240).optional(),
});

export async function PATCH(request: Request, context: RouteContext) {
    try {
        const admin = await requireAdmin();

        if (!db) {
            return NextResponse.json({ error: 'Database not available' }, { status: 503 });
        }

        const { id } = await context.params;
        const body = await request.json();
        const data = updateSchema.parse(body);

        const report = await db.query.reports.findFirst({
            where: { id: id },
        });

        if (!report) {
            return NextResponse.json({ error: 'Report not found' }, { status: 404 });
        }

        const [updated] = await db.update(reports)
            .set({
                status: data.status,
                resolvedAt: data.status === 'resolved' ? new Date() : null,
                resolvedBy: data.status === 'resolved' ? admin.id : null,
                resolutionNote: data.note || null,
            })
            .where(eq(reports.id, id))
            .returning();

        return NextResponse.json({ report: updated });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return NextResponse.json({ error: 'Invalid input', details: error.issues }, { status: 400 });
        }
        if (error instanceof Error && error.message === 'Admin required') {
            return NextResponse.json({ error: 'Admin required' }, { status: 403 });
        }
        console.error('Report update error:', error);
        return NextResponse.json({ error: 'Failed to update report' }, { status: 500 });
    }
}
