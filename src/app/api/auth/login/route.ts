import { NextResponse } from 'next/server';
import { z } from 'zod';

import { authenticateUser, createSession } from '@/lib/auth';
import {
    admitLoginRequest,
    clearLoginFailures,
    createAuthAbuseContext,
    recordLoginFailure,
    tryAcquireAuthWork,
} from '@/lib/auth/abuse-protection';
import { isLocalNodeNsfw } from '@/lib/node/local-node';
import { getTurnstileConfiguration, verifyTurnstileToken } from '@/lib/turnstile';

const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().max(1_024),
    turnstileToken: z.string().max(4_096).optional().nullable(),
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
        const data = loginSchema.parse(body);
        const abuseContext = createAuthAbuseContext(request, data.email);
        const admission = await admitLoginRequest(abuseContext);

        if (!admission.allowed) {
            return retryResponse(
                'Too many sign-in attempts. Please wait a little before trying again.',
                admission.retryAfterSeconds,
            );
        }

        // Ordinary sign-ins do not contact Cloudflare. A challenge becomes
        // mandatory only after repeated failures, and only on configured nodes.
        if (admission.challengeRequired) {
            const configuration = await getTurnstileConfiguration();
            if (configuration) {
                if (!data.turnstileToken) {
                    return NextResponse.json({
                        error: 'Please complete the security check to continue.',
                        requiresTurnstile: true,
                        turnstileAction: 'login',
                    }, { status: 403 });
                }
                const verified = await verifyTurnstileToken(data.turnstileToken, {
                    action: 'login',
                    configuration,
                    ip: abuseContext.clientAddress,
                });
                if (!verified) {
                    return NextResponse.json({
                        error: 'The security check failed. Please try it again.',
                        requiresTurnstile: true,
                        turnstileAction: 'login',
                    }, { status: 403 });
                }
            }
        }

        const releaseWork = tryAcquireAuthWork('login');
        if (!releaseWork) {
            return retryResponse('The sign-in service is busy. Please try again shortly.', 2);
        }

        try {
            const user = await authenticateUser(data.email, data.password);
            const localNodeIsNsfw = await isLocalNodeNsfw();
            await createSession(user.id);
            await clearLoginFailures(abuseContext);

            return NextResponse.json({
                success: true,
                user: {
                    id: user.id,
                    handle: user.handle,
                    username: user.username,
                    homeDomain: user.homeDomain,
                    isLocalAccount: user.isLocalAccount,
                    displayName: user.displayName,
                    avatarUrl: user.avatarUrl,
                    bio: user.bio,
                    headerUrl: user.headerUrl,
                    website: user.website,
                    profileVersion: user.profileVersion,
                    did: user.did,
                    publicKey: user.publicKey,
                    privateKeyEncrypted: user.privateKeyEncrypted,
                    isNsfw: user.isNsfw,
                    nsfwEnabled: localNodeIsNsfw
                        ? Boolean(user.ageVerifiedAt)
                        : user.nsfwEnabled,
                    ageVerifiedAt: user.ageVerifiedAt?.toISOString() || null,
                },
            });
        } catch (error) {
            if (error instanceof Error && error.message === 'Invalid email or password') {
                await recordLoginFailure(abuseContext);
                return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
            }
            console.error('Login error:', error);
            return NextResponse.json({ error: 'Login failed' }, { status: 500 });
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
        console.error('Login request error:', error);
        return NextResponse.json({ error: 'Login failed' }, { status: 500 });
    }
}
