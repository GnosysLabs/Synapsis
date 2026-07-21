import { NextRequest, NextResponse } from 'next/server';
import { db, isDbAvailable } from '@/db';
import { requireCanonicalAccountHomeDomain } from '@/lib/identity/account-address';

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
        const homeDomain = requireCanonicalAccountHomeDomain(
            process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
        );

        if (!handle || handle.length < 3) {
            return NextResponse.json({ available: false, error: 'Handle too short' });
        }

        if (!/^[a-zA-Z0-9_]+$/.test(handle)) {
            return NextResponse.json({ available: false, error: 'Invalid characters' });
        }

        let existingUser = null;
        try {
            existingUser = await db.query.users.findFirst({
                where: { AND: [{ username: handle }, { homeDomain }] },
            });
        } catch (err: unknown) {
            // Handle fresh installs where the users table isn't created yet.
            const databaseError = err instanceof Error
                ? Object.assign(err, { code: (err as Error & { code?: string }).code })
                : null;
            if (databaseError?.code === '42P01' || /relation .*users.* does not exist/i.test(databaseError?.message || '')) {
                return NextResponse.json(
                    { available: true, handle, warning: 'Database not initialized' },
                    { status: 503 }
                );
            }
            throw err;
        }

        const deletedHandle = await db.query.swarmAccountTombstones.findFirst({
            where: { handle: `${handle}@${homeDomain}` },
        });

        return NextResponse.json({
            available: !existingUser && !deletedHandle,
            handle
        });
    } catch (error) {
        console.error('Check handle error:', error);
        return NextResponse.json({ error: 'Failed to check handle' }, { status: 500 });
    }
}
