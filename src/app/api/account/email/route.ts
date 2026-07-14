import { NextResponse } from 'next/server';
import { db, users } from '@/db';
import { eq } from 'drizzle-orm';
import { requireSignedAction, type SignedAction } from '@/lib/auth/verify-signature';
import { verifyPassword } from '@/lib/auth';

export async function POST(request: Request) {
    try {
        const signedAction: SignedAction = await request.json();

        // Verify signature and get user
        const user = await requireSignedAction(signedAction);

        if (signedAction.action !== 'change_email') {
            return NextResponse.json(
                { error: 'Invalid action type' },
                { status: 400 }
            );
        }

        const { newEmail, currentPassword } = signedAction.data;

        // Verify current password
        if (!user.passwordHash) {
            return NextResponse.json(
                { error: 'Account has no password set' },
                { status: 400 }
            );
        }

        const isPasswordValid = await verifyPassword(currentPassword, user.passwordHash);
        
        if (!isPasswordValid) {
            return NextResponse.json(
                { error: 'Current password is incorrect' },
                { status: 403 }
            );
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(newEmail)) {
            return NextResponse.json(
                { error: 'Invalid email format' },
                { status: 400 }
            );
        }

        // Check if email is already taken by another user
        const existingUser = await db.query.users.findFirst({
            where: { email: newEmail.toLowerCase() },
        });

        if (existingUser && existingUser.id !== user.id) {
            return NextResponse.json(
                { error: 'Email is already registered to another account' },
                { status: 400 }
            );
        }

        // Update email
        await db.update(users)
            .set({ email: newEmail.toLowerCase() })
            .where(eq(users.id, user.id));

        return NextResponse.json({
            success: true,
            message: 'Email updated successfully',
        });

    } catch (error) {
        console.error('Email change error:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Failed to change email' },
            { status: 500 }
        );
    }
}
