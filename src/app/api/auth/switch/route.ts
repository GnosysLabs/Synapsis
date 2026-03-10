import { NextResponse } from 'next/server';
import { switchSession } from '@/lib/auth';
import { z } from 'zod';

const switchSchema = z.object({
    userId: z.string().uuid(),
});

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const data = switchSchema.parse(body);
        const session = await switchSession(data.userId);

        return NextResponse.json({
            success: true,
            user: {
                id: session.user.id,
                handle: session.user.handle,
                displayName: session.user.displayName,
                avatarUrl: session.user.avatarUrl,
                bio: session.user.bio,
                website: session.user.website,
                dmPrivacy: session.user.dmPrivacy,
                did: session.user.did,
                publicKey: session.user.publicKey,
                privateKeyEncrypted: session.user.privateKeyEncrypted,
            },
        });
    } catch (error) {
        console.error('Switch session error:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Failed to switch account' },
            { status: 400 }
        );
    }
}
