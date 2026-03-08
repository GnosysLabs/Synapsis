import { NextResponse } from 'next/server';
import { registerUser, createSession } from '@/lib/auth';
import { createStorageSession } from '@/lib/storage/session';
import { db, nodes, users } from '@/db';
import { eq } from 'drizzle-orm';
import { verifyTurnstileToken } from '@/lib/turnstile';
import { testS3Credentials } from '@/lib/storage/s3';
import { z } from 'zod';

const registerSchema = z.object({
    handle: z.string().min(3).max(20).regex(/^[a-zA-Z0-9_]+$/),
    email: z.string().email(),
    password: z.string().min(8),
    displayName: z.string().optional(),
    turnstileToken: z.string().nullable().optional(),
    // S3-compatible storage credentials
    storageProvider: z.string().min(1),
    storageEndpoint: z.string().nullable().optional(),
    storagePublicBaseUrl: z.string().nullable().optional(),
    storageRegion: z.string().min(1),
    storageBucket: z.string().min(1),
    storageAccessKey: z.string().min(10),
    storageSecretKey: z.string().min(10),
});

export async function POST(request: Request) {
    try {
        const body = await request.json();

        // Log registration attempt (excluding password)
        const { password, ...logData } = body;
        console.log('Registration attempt details:', logData);

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

        // Test S3 credentials before creating account
        console.log('[Register] Testing S3 credentials...');
        const s3Test = await testS3Credentials(
            data.storageEndpoint || null,
            data.storageRegion,
            data.storageBucket,
            data.storageAccessKey,
            data.storageSecretKey
        );

        if (!s3Test.success) {
            console.error('[Register] S3 credential test failed:', s3Test.error);
            return NextResponse.json(
                { error: `Storage connection failed: ${s3Test.error}` },
                { status: 400 }
            );
        }

        console.log('[Register] S3 credentials verified successfully');

        const user = await registerUser(
            data.handle,
            data.email,
            data.password,
            data.displayName,
            data.storageProvider,
            data.storageEndpoint || null,
            data.storagePublicBaseUrl || null,
            data.storageRegion,
            data.storageBucket,
            data.storageAccessKey,
            data.storageSecretKey
        );

        // Check if this is an NSFW node and auto-enable NSFW settings
        const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:3000';
        const node = await db.query.nodes.findFirst({
            where: eq(nodes.domain, nodeDomain),
        });

        if (node?.isNsfw) {
            // Auto-enable NSFW viewing and mark account as NSFW for users on NSFW nodes
            await db.update(users)
                .set({
                    nsfwEnabled: true,
                    isNsfw: true
                })
                .where(eq(users.id, user.id));
        }

        // Create session for new user
        await createSession(user.id);
        await createStorageSession(user, data.password);

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
