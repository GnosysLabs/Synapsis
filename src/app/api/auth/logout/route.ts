import { NextResponse } from 'next/server';
import { destroySession, getSession } from '@/lib/auth';
import { clearStorageSession } from '@/lib/storage/session';
import { z } from 'zod';

const logoutSchema = z.object({
    userId: z.string().uuid().optional(),
});

export async function POST(request: Request) {
    try {
        const currentSession = await getSession();
        const body = await request.json().catch(() => ({}));
        const data = logoutSchema.parse(body);

        const targetUserId = data.userId ?? currentSession?.user.id;

        if (targetUserId) {
            await clearStorageSession(targetUserId);
        }

        await destroySession(targetUserId);

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Logout error:', error);
        return NextResponse.json(
            { error: 'Logout failed' },
            { status: 500 }
        );
    }
}
