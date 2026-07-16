import { NextResponse } from 'next/server';
import { db, users } from '@/db';
import { requireAdmin } from '@/lib/auth/admin';
import { desc, sql } from 'drizzle-orm';

export async function GET(request: Request) {
    try {
        await requireAdmin();

        if (!db) {
            return NextResponse.json({ error: 'Database not available' }, { status: 503 });
        }

        const { searchParams } = new URL(request.url);
        const limit = Math.min(parseInt(searchParams.get('limit') || '25'), 50);

        const results = await db.select({
            id: users.id,
            handle: users.handle,
            displayName: users.displayName,
            email: users.email,
            isSuspended: users.isSuspended,
            suspensionReason: users.suspensionReason,
            isSilenced: users.isSilenced,
            silenceReason: users.silenceReason,
            createdAt: users.createdAt,
        })
            .from(users)
            .where(sql`${users.handle} NOT LIKE '%@%'`)
            .orderBy(desc(users.createdAt))
            .limit(limit);

        return NextResponse.json({ users: results });
    } catch (error) {
        if (error instanceof Error && error.message === 'Admin required') {
            return NextResponse.json({ error: 'Admin required' }, { status: 403 });
        }
        console.error('Admin users error:', error);
        return NextResponse.json({ error: 'Failed to fetch users' }, { status: 500 });
    }
}
