import { NextResponse } from 'next/server';
import { registerUser, createSession } from '@/lib/auth';
import { db, users } from '@/db';
import { eq } from 'drizzle-orm';
import { verifyTurnstileToken } from '@/lib/turnstile';
import { z } from 'zod';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';

const registerSchema = z.object({
    handle: z.string().min(3).max(20).regex(/^[a-zA-Z0-9_]+$/),
    email: z.string().email(),
    password: z.string().min(8),
    displayName: z.string().trim().max(50).optional(),
    turnstileToken: z.string().nullable().optional(),
    confirmAge: z.boolean().optional(),
});

export async function POST(request: Request) {
    try {
        const body = await request.json();

        // Log registration attempt (excluding password)
        console.log('Registration attempt:', { handle: body.handle, email: body.email });

        const data = registerSchema.parse(body);

        // Verify Turnstile token if provided
        if (data.turnstileToken) {
            const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || undefined;
            const isValid = await verifyTurnstileToken(data.turnstileToken, ip);
            if (!isValid) {
                console.error('Turnstile verification failed for handle:', data.handle);
                return NextResponse.json(
                    { error: 'Bot verification failed. Please try again.' },
                    { status: 400 }
                );
            }
        }

        const nodeIsNsfw = await requireLocalNodeNsfwClassification();
        if (nodeIsNsfw && data.confirmAge !== true) {
            return NextResponse.json({
                error: 'You must confirm that you are 18 or older to register on this adult-only node.',
                requiresAgeConfirmation: true,
            }, { status: 400 });
        }

        const user = await registerUser(
            data.handle,
            data.email,
            data.password,
            data.displayName
        );

        const verifiedAt = nodeIsNsfw ? new Date() : user.ageVerifiedAt;
        if (nodeIsNsfw) {
            // Auto-enable NSFW viewing and mark account as NSFW for users on NSFW nodes
            await db.update(users)
                .set({
                    nsfwEnabled: true,
                    isNsfw: true,
                    ageVerifiedAt: verifiedAt,
                })
                .where(eq(users.id, user.id));
        }

        // Create session for new user
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
                isNsfw: nodeIsNsfw ? true : user.isNsfw,
                nsfwEnabled: nodeIsNsfw ? true : user.nsfwEnabled,
                ageVerifiedAt: verifiedAt?.toISOString() || null,
            },
        });
    } catch (error) {
        console.error('Registration error detailed:', error);

        if (error instanceof z.ZodError) {
            console.error('Validation error:', error.issues);
            return NextResponse.json(
                { error: 'Invalid input', details: error.issues },
                { status: 400 }
            );
        }

        const errorMessage = error instanceof Error ? error.message : 'Registration failed';

        // Return 400 for known business logic errors
        if (errorMessage.includes('taken') || errorMessage.includes('registered') || errorMessage.includes('Handle must be')) {
            return NextResponse.json(
                { error: errorMessage },
                { status: 400 }
            );
        }

        // Return 500 for everything else so we can see it's a server error
        return NextResponse.json(
            { error: `Server error: ${errorMessage}` },
            { status: 500 }
        );
    }
}
