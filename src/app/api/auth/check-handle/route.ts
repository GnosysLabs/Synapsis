import { NextRequest, NextResponse } from 'next/server';
import { db, users, isDbAvailable } from '@/db';
import { eq } from 'drizzle-orm';

export async function GET(req: NextRequest) {
    try {
        if (!isDbAvailable()) {
            return NextResponse.json(
                { available: false, error: 'Database not configured' },
                { status: 503 }
            );
        }

        const { searchParams } = new URL(req.url);
        const handle = searchParams.get('handle')?.toLowerCase().trim();

        if (!handle || handle.length < 3) {
            return NextResponse.json({ available: false, error: 'Handle too short' });
        }

        if (!/^[a-zA-Z0-9_]+$/.test(handle)) {
            return NextResponse.json({ available: false, error: 'Invalid characters' });
        }

        let existingUser = null;
        try {
            existingUser = await db.query.users.findFirst({
                where: { handle: handle },
            });
        } catch (err: any) {
            // Handle fresh installs where the users table isn't created yet.
            if (err?.code === '42P01' || /relation .*users.* does not exist/i.test(err?.message || '')) {
                return NextResponse.json(
                    { available: true, handle, warning: 'Database not initialized' },
                    { status: 503 }
                );
            }
            throw err;
        }

        return NextResponse.json({
            available: !existingUser,
            handle
        });
    } catch (error) {
        console.error('Check handle error:', error);
        return NextResponse.json({ error: 'Failed to check handle' }, { status: 500 });
    }
}
