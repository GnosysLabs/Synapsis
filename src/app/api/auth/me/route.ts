import { NextResponse } from 'next/server';
import { getSession, getSessionAccounts } from '@/lib/auth';
import { db, users } from '@/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireSignedAction, type SignedAction } from '@/lib/auth/verify-signature';

const updateProfileSchema = z.object({
    displayName: z.string().min(1).max(50).optional(),
    bio: z.string().max(160).optional().nullable(),
    avatarUrl: z.string().url().or(z.string().length(0)).optional().nullable(),
    headerUrl: z.string().url().or(z.string().length(0)).optional().nullable(),
    website: z.string().url().or(z.string().length(0)).optional().nullable(),
    dmPrivacy: z.enum(['everyone', 'following', 'none']).optional(),
});

export async function GET() {
    try {
        // Return null user if no database is connected (for UI testing)
        if (!db) {
            return NextResponse.json({ user: null });
        }

        const session = await getSession();
        const accounts = await getSessionAccounts();

        if (!session) {
            return NextResponse.json({ user: null, accounts: [] });
        }

        return NextResponse.json({
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
            accounts,
        });
    } catch (error) {
        console.error('Session check error:', error);
        return NextResponse.json({ user: null, accounts: [] });
    }
}

export async function PATCH(request: Request) {
    try {
        if (!db) {
            return NextResponse.json({ error: 'Database not available' }, { status: 503 });
        }

        // Parse signed action
        const signedAction: SignedAction = await request.json();

        // Verify signature and get user
        // This ensures the request was signed by the user's private key
        const currentUser = await requireSignedAction(signedAction);

        // Ensure the action type is correct for profile updates
        if (signedAction.action !== 'update_profile') {
            return NextResponse.json({ error: 'Invalid action type' }, { status: 400 });
        }

        // Parse inner data
        const data = updateProfileSchema.parse(signedAction.data);

        const updateData: {
            displayName?: string;
            bio?: string | null;
            avatarUrl?: string | null;
            headerUrl?: string | null;
            website?: string | null;
            dmPrivacy?: 'everyone' | 'following' | 'none';
            updatedAt?: Date;
        } = {};

        if (data.displayName !== undefined) updateData.displayName = data.displayName;
        if (data.bio !== undefined) updateData.bio = data.bio === '' ? null : data.bio;
        if (data.avatarUrl !== undefined) updateData.avatarUrl = data.avatarUrl === '' ? null : data.avatarUrl;
        if (data.headerUrl !== undefined) updateData.headerUrl = data.headerUrl === '' ? null : data.headerUrl;
        if (data.website !== undefined) updateData.website = data.website === '' ? null : data.website;
        if (data.dmPrivacy !== undefined) updateData.dmPrivacy = data.dmPrivacy;

        if (Object.keys(updateData).length === 0) {
            return NextResponse.json({
                user: {
                    id: currentUser.id,
                    handle: currentUser.handle,
                    displayName: currentUser.displayName,
                    avatarUrl: currentUser.avatarUrl,
                    bio: currentUser.bio,
                    headerUrl: currentUser.headerUrl,
                    website: currentUser.website,
                    dmPrivacy: currentUser.dmPrivacy,
                    followersCount: currentUser.followersCount,
                    followingCount: currentUser.followingCount,
                    postsCount: currentUser.postsCount,
                    createdAt: currentUser.createdAt,
                },
            });
        }

        updateData.updatedAt = new Date();

        const [updatedUser] = await db.update(users)
            .set(updateData)
            .where(eq(users.id, currentUser.id))
            .returning();

        return NextResponse.json({
            user: {
                id: updatedUser.id,
                handle: updatedUser.handle,
                displayName: updatedUser.displayName,
                avatarUrl: updatedUser.avatarUrl,
                bio: updatedUser.bio,
                headerUrl: updatedUser.headerUrl,
                website: updatedUser.website,
                dmPrivacy: updatedUser.dmPrivacy,
                followersCount: updatedUser.followersCount,
                followingCount: updatedUser.followingCount,
                postsCount: updatedUser.postsCount,
                createdAt: updatedUser.createdAt,
            },
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return NextResponse.json({ error: 'Invalid input', details: error.issues }, { status: 400 });
        }
        if (error instanceof Error) {
            if (error.message === 'Authentication required') {
                return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
            }
            if (error.message === 'Invalid signature' || error.message === 'User not found') {
                return NextResponse.json({ error: 'Invalid signature or identity' }, { status: 403 });
            }
        }
        console.error('Profile update error:', error);
        return NextResponse.json({ error: 'Failed to update profile' }, { status: 500 });
    }
}
