import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { db, users } from '@/db';
import { registerUser, createSession } from '@/lib/auth';
import {
    admitRegistrationRequest,
    createAuthAbuseContext,
    tryAcquireAuthWork,
} from '@/lib/auth/abuse-protection';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { getTurnstileConfiguration, verifyTurnstileToken } from '@/lib/turnstile';

const registerSchema = z.object({
    handle: z.string().min(3).max(20).regex(/^[a-zA-Z0-9_]+$/),
    email: z.string().email(),
    password: z.string().min(8).max(1_024),
    displayName: z.string().trim().max(50).optional(),
    turnstileToken: z.string().max(4_096).nullable().optional(),
    confirmAge: z.boolean().optional(),
});

function retryResponse(message: string, retryAfterSeconds: number) {
    return NextResponse.json(
        { error: message, retryAfterSeconds },
        {
            status: 429,
            headers: { 'Retry-After': String(Math.max(1, retryAfterSeconds)) },
        },
    );
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const data = registerSchema.parse(body);
        const nodeIsNsfw = await requireLocalNodeNsfwClassification();
        if (nodeIsNsfw && data.confirmAge !== true) {
            return NextResponse.json({
                error: 'You must confirm that you are 18 or older to register on this adult-only node.',
                requiresAgeConfirmation: true,
            }, { status: 400 });
        }

        const abuseContext = createAuthAbuseContext(request, data.email);
        const admission = await admitRegistrationRequest(abuseContext);
        if (!admission.allowed) {
            return retryResponse(
                'Too many account-creation attempts. Please try again later.',
                admission.retryAfterSeconds,
            );
        }

        // Registration becomes interactive after repeated attempts from the
        // same client or for the same identity. The first normal attempt stays
        // fast and independent of Cloudflare.
        if (admission.challengeRequired) {
            const configuration = await getTurnstileConfiguration();
            if (configuration) {
                if (!data.turnstileToken) {
                    return NextResponse.json({
                        error: 'Please complete the security check to continue.',
                        requiresTurnstile: true,
                        turnstileAction: 'register',
                    }, { status: 403 });
                }
                const verified = await verifyTurnstileToken(data.turnstileToken, {
                    action: 'register',
                    configuration,
                    ip: abuseContext.clientAddress,
                });
                if (!verified) {
                    return NextResponse.json({
                        error: 'The security check failed. Please try it again.',
                        requiresTurnstile: true,
                        turnstileAction: 'register',
                    }, { status: 403 });
                }
            }
        }

        const releaseWork = tryAcquireAuthWork('register');
        if (!releaseWork) {
            return retryResponse('Account creation is busy. Please try again shortly.', 3);
        }

        try {
            const user = await registerUser(
                data.handle,
                data.email,
                data.password,
                data.displayName,
            );

            const verifiedAt = nodeIsNsfw ? new Date() : user.ageVerifiedAt;
            if (nodeIsNsfw) {
                await db.update(users)
                    .set({
                        nsfwEnabled: true,
                        isNsfw: true,
                        ageVerifiedAt: verifiedAt,
                    })
                    .where(eq(users.id, user.id));
            }

            await createSession(user.id);
            return NextResponse.json({
                success: true,
                user: {
                    id: user.id,
                    handle: user.handle,
                    username: user.username,
                    homeDomain: user.homeDomain,
                    isLocalAccount: user.isLocalAccount,
                    displayName: user.displayName,
                    did: user.did,
                    publicKey: user.publicKey,
                    privateKeyEncrypted: user.privateKeyEncrypted,
                    isNsfw: nodeIsNsfw ? true : user.isNsfw,
                    nsfwEnabled: nodeIsNsfw ? true : user.nsfwEnabled,
                    ageVerifiedAt: verifiedAt?.toISOString() || null,
                },
            });
        } finally {
            releaseWork();
        }
    } catch (error) {
        if (error instanceof z.ZodError) {
            return NextResponse.json(
                { error: 'Invalid input', details: error.issues },
                { status: 400 },
            );
        }

        const errorMessage = error instanceof Error ? error.message : 'Registration failed';
        if (errorMessage.includes('taken')
            || errorMessage.includes('registered')
            || errorMessage.includes('Handle must')) {
            return NextResponse.json({ error: errorMessage }, { status: 400 });
        }

        console.error('Registration error:', error);
        return NextResponse.json({ error: 'Account creation failed' }, { status: 500 });
    }
}
