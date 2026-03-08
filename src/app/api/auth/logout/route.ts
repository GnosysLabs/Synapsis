import { NextResponse } from 'next/server';
import { destroySession } from '@/lib/auth';
import { clearStorageSession } from '@/lib/storage/session';

export async function POST() {
    try {
        await clearStorageSession();
        await destroySession();

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Logout error:', error);
        return NextResponse.json(
            { error: 'Logout failed' },
            { status: 500 }
        );
    }
}
