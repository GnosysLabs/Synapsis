import { NextResponse } from 'next/server';
import { getSession, getSessionAccounts } from '@/lib/auth';
import { db, notifications, users } from '@/db';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import { requireSignedAction, type SignedAction } from '@/lib/auth/verify-signature';
import { isLocalNodeNsfw } from '@/lib/node/local-node';
import { getOrRefreshStuffboxBadge } from '@/lib/stuffbox/badge-status';
import {
    PUBLISH_PROFILE_ACTION,
    signedProfileDocumentSchema,
} from '@/lib/profile/profile-document';

const updateProfileSchema = z.object({
    displayName: z.string().min(1).max(50).optional(),
    bio: z.string().max(160).optional().nullable(),
    avatarUrl: z.string().url().or(z.string().length(0)).optional().nullable(),
    headerUrl: z.string().url().or(z.string().length(0)).optional().nullable(),
    website: z.string().url().or(z.string().length(0)).optional().nullable(),
    dmPrivacy: z.enum(['everyone', 'following', 'none']).optional(),
});

class ProfileVersionConflictError extends Error {}

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

        const localNodeIsNsfw = await isLocalNodeNsfw();
        // The active account is the authoritative place to detect a plan
        // change after the user returns from Stuffbox.
        const stuffboxBadge = await getOrRefreshStuffboxBadge(session.user, { force: true });
        const moveDelivery = session.user.movedFrom
            ? await db.query.accountMoveDeliveries.findFirst({ where: { userId: session.user.id } })
            : null;

        return NextResponse.json({
            user: {
                id: session.user.id,
                handle: session.user.handle,
                username: session.user.username,
                homeDomain: session.user.homeDomain,
                isLocalAccount: session.user.isLocalAccount,
                displayName: session.user.displayName,
                avatarUrl: session.user.avatarUrl,
                bio: session.user.bio,
                headerUrl: session.user.headerUrl,
                website: session.user.website,
                dmPrivacy: session.user.dmPrivacy,
                profileVersion: session.user.profileVersion,
                did: session.user.did,
                publicKey: session.user.publicKey,
                privateKeyEncrypted: session.user.privateKeyEncrypted,
                isNsfw: session.user.isNsfw,
                nsfwEnabled: localNodeIsNsfw
                    ? Boolean(session.user.ageVerifiedAt)
                    : session.user.nsfwEnabled,
                ageVerifiedAt: session.user.ageVerifiedAt?.toISOString() || null,
                stuffboxBadge,
                movedFrom: session.user.movedFrom,
                sourceCleanupConfirmed: moveDelivery?.status === 'confirmed',
            },
            accounts: accounts.map((account) => ({
                ...account,
                nsfwEnabled: localNodeIsNsfw
                    ? Boolean(account.ageVerifiedAt)
                    : account.nsfwEnabled,
                stuffboxBadge: account.id === session.user.id
                    ? stuffboxBadge
                    : account.stuffboxBadge,
            })),
        });
    } catch (error) {
        console.error('Session check error:', error);
        return NextResponse.json(
            { error: 'Session check temporarily unavailable' },
            { status: 503 },
        );
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

        // Public presentation is a complete, durable profile document. Private
        // preferences remain ordinary partial updates and are never federated.
        if (signedAction.action !== 'update_profile'
            && signedAction.action !== PUBLISH_PROFILE_ACTION) {
            return NextResponse.json({ error: 'Invalid action type' }, { status: 400 });
        }

        const updateData: {
            displayName?: string;
            bio?: string | null;
            avatarUrl?: string | null;
            headerUrl?: string | null;
            website?: string | null;
            dmPrivacy?: 'everyone' | 'following' | 'none';
            profileDocumentJson?: string | null;
            profileVersion?: number | null;
            updatedAt?: Date;
        } = {};

        if (signedAction.action === PUBLISH_PROFILE_ACTION) {
            const profileDocument = signedProfileDocumentSchema.parse(signedAction);
            updateData.displayName = profileDocument.data.displayName;
            updateData.bio = profileDocument.data.bio;
            updateData.avatarUrl = profileDocument.data.avatarUrl;
            updateData.headerUrl = profileDocument.data.headerUrl;
            updateData.website = profileDocument.data.website;
            updateData.profileDocumentJson = JSON.stringify(profileDocument);
            updateData.profileVersion = profileDocument.ts;
        } else {
            const data = updateProfileSchema.parse(signedAction.data);
            if (data.displayName !== undefined) updateData.displayName = data.displayName;
            if (data.bio !== undefined) updateData.bio = data.bio === '' ? null : data.bio;
            if (data.avatarUrl !== undefined) updateData.avatarUrl = data.avatarUrl === '' ? null : data.avatarUrl;
            if (data.headerUrl !== undefined) updateData.headerUrl = data.headerUrl === '' ? null : data.headerUrl;
            if (data.website !== undefined) updateData.website = data.website === '' ? null : data.website;
            if (data.dmPrivacy !== undefined) updateData.dmPrivacy = data.dmPrivacy;
            if (data.displayName !== undefined
                || data.bio !== undefined
                || data.avatarUrl !== undefined
                || data.headerUrl !== undefined
                || data.website !== undefined) {
                // Old clients may still send partial public updates. Do not
                // publish a now-stale proof; the next unlock will replace it
                // with a complete signed document.
                updateData.profileDocumentJson = null;
                updateData.profileVersion = null;
            }
        }

        if (Object.keys(updateData).length === 0) {
            return NextResponse.json({
                user: {
                    id: currentUser.id,
                    handle: currentUser.handle,
                    username: currentUser.username,
                    homeDomain: currentUser.homeDomain,
                    isLocalAccount: currentUser.isLocalAccount,
                    displayName: currentUser.displayName,
                    avatarUrl: currentUser.avatarUrl,
                    bio: currentUser.bio,
                    headerUrl: currentUser.headerUrl,
                    website: currentUser.website,
                    dmPrivacy: currentUser.dmPrivacy,
                    profileVersion: currentUser.profileVersion,
                    followersCount: currentUser.followersCount,
                    followingCount: currentUser.followingCount,
                    postsCount: currentUser.postsCount,
                    createdAt: currentUser.createdAt,
                },
            });
        }

        updateData.updatedAt = new Date();

        const updatedUser = await db.transaction(async (tx) => {
            const [freshUser] = await tx.update(users)
                .set(updateData)
                .where(signedAction.action === PUBLISH_PROFILE_ACTION
                    ? and(
                        eq(users.id, currentUser.id),
                        or(
                            isNull(users.profileVersion),
                            lt(users.profileVersion, signedAction.ts),
                        ),
                    )
                    : eq(users.id, currentUser.id))
                .returning();
            if (!freshUser) throw new ProfileVersionConflictError();

            // Historical notifications identify the actor canonically, but
            // their presentation fields are snapshots. Keep local snapshots
            // aligned as part of the same profile update so legacy/null actor
            // IDs cannot leave an old avatar behind.
            await tx.update(notifications)
                .set({
                    actorDisplayName: freshUser.displayName,
                    actorAvatarUrl: freshUser.avatarUrl,
                })
                .where(or(
                    eq(notifications.actorId, currentUser.id),
                    and(
                        eq(notifications.actorHandle, currentUser.handle),
                        eq(notifications.actorNodeDomain, currentUser.homeDomain),
                    ),
                ));

            return freshUser;
        });

        return NextResponse.json({
            user: {
                id: updatedUser.id,
                handle: updatedUser.handle,
                username: updatedUser.username,
                homeDomain: updatedUser.homeDomain,
                isLocalAccount: updatedUser.isLocalAccount,
                displayName: updatedUser.displayName,
                avatarUrl: updatedUser.avatarUrl,
                bio: updatedUser.bio,
                headerUrl: updatedUser.headerUrl,
                website: updatedUser.website,
                dmPrivacy: updatedUser.dmPrivacy,
                profileVersion: updatedUser.profileVersion,
                followersCount: updatedUser.followersCount,
                followingCount: updatedUser.followingCount,
                postsCount: updatedUser.postsCount,
                createdAt: updatedUser.createdAt,
            },
        });
    } catch (error) {
        if (error instanceof ProfileVersionConflictError) {
            return NextResponse.json({ error: 'A newer profile update already exists' }, { status: 409 });
        }
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
