import { NextResponse } from 'next/server';
import { authenticateUser, createSession } from '@/lib/auth';
import { verifyTurnstileToken } from '@/lib/turnstile';
import { z } from 'zod';

const loginSchema = z.object({
    email: z.string().email(),
    password: z.string(),
    turnstileToken: z.string().optional().nullable(),
});

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const data = loginSchema.parse(body);

        // Verify Turnstile token only if it's provided (meaning Turnstile is enabled)
        if (data.turnstileToken) {
            const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || undefined;
            const isValid = await verifyTurnstileToken(data.turnstileToken, ip);
            if (!isValid) {
                return NextResponse.json(
                    { error: 'Bot verification failed. Please try again.' },
                    { status: 400 }
                );
            }
        }

        const user = await authenticateUser(data.email, data.password);

        // Create session
        await createSession(user.id);

        return NextResponse.json({
            success: true,
            user: {
                id: user.id,
                handle: user.handle,
                displayName: user.displayName,
                did: user.did,
                publicKey: user.publicKey,
                privateKeyEncrypted: user.privateKeyEncrypted, // Client will decrypt with password
            },
        });
    } catch (error) {
        console.error('Login error:', error);

        if (error instanceof z.ZodError) {
            return NextResponse.json(
                { error: 'Invalid input', details: error.issues },
                { status: 400 }
            );
        }

        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Login failed' },
            { status: 401 }
        );
    }
}
