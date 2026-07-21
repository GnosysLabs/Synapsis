import { db } from '@/db';
import { users } from '@/db/schema';
import {
    didKeyMatchesPublicKey,
    normalizeSigningPublicKey,
} from '@/lib/crypto/did-key';
import { and, eq } from 'drizzle-orm';
import { withSqliteLockRetry } from '@/lib/db/sqlite-lock-retry';
import { parseAccountAddress } from '@/lib/identity/account-address';
import type { StuffboxBadge } from '@/lib/types';
import { stuffboxBadgeColumns } from '@/lib/stuffbox/badge';
import type { SignedProfileDocument } from '@/lib/profile/profile-document';
import { verifyProfileDocument } from '@/lib/profile/verify-profile-document';

export interface RemoteProfile {
    handle: string;
    displayName: string;
    avatarUrl?: string | null;
    bio?: string | null;
    headerUrl?: string | null;
    website?: string | null;
    did: string;
    publicKey?: string;
    isNsfw?: boolean;
    stuffboxBadge?: StuffboxBadge | null;
    profileDocument?: SignedProfileDocument;
    profileVersion?: number;
}

type VerifiedRemoteProfile = RemoteProfile & { publicKey: string };
export type RemoteUserCacheDatabase = Pick<typeof db, 'query' | 'insert' | 'update'>;

function signingKeysEqual(left: string, right: string): boolean {
    const normalizedLeft = normalizeSigningPublicKey(left);
    const normalizedRight = normalizeSigningPublicKey(right);
    return normalizedLeft && normalizedRight
        ? normalizedLeft === normalizedRight
        : left === right;
}

async function upsertVerifiedRemoteUser(
    profile: VerifiedRemoteProfile,
    database: RemoteUserCacheDatabase,
): Promise<void> {
    // The durable verified registry is the identity authority. Legacy remote
    // user rows were populated from node directory hints and may contain
    // synthetic did:swarm:* values; a valid user proof may replace those hints
    // only after this exact handle was pinned.
    const pinned = await database.query.handleRegistry.findFirst({
        where: {
            AND: [
                { handle: profile.handle },
                { did: profile.did },
                { identityVerified: true },
                { deletedAt: { isNull: true } },
            ],
        },
    });
    if (!pinned) {
        throw new Error('Remote user identity is not verified for this handle');
    }

    const [byDid, byHandle] = await Promise.all([
        database.query.users.findFirst({ where: { did: profile.did } }),
        database.query.users.findFirst({ where: { handle: profile.handle } }),
    ]);
    if (byDid && byHandle && byDid.id !== byHandle.id) {
        throw new Error('Remote user identity conflicts with the existing cache');
    }
    if (byDid && byDid.handle !== profile.handle) {
        throw new Error('Remote DID is already bound to another handle');
    }
    const existing = byHandle || byDid;

    if (existing) {
        if (existing.isLocalAccount) {
            throw new Error('Federation cannot modify a local user');
        }
        if (existing.handle !== profile.handle) {
            throw new Error('Remote user handle changed unexpectedly');
        }

        const replacingLegacyHint = existing.did !== profile.did;
        if (!replacingLegacyHint
            && existing.publicKey
            && !signingKeysEqual(profile.publicKey, existing.publicKey)) {
            throw new Error('Remote user signing key changed unexpectedly');
        }

        const canRefreshPresentation = profile.profileVersion !== undefined
            ? existing.profileVersion === null
                || existing.profileVersion === undefined
                || profile.profileVersion > existing.profileVersion
            : existing.profileVersion === null || existing.profileVersion === undefined;

        await database.update(users)
            .set({
                // A verified handle pin may replace a legacy, unverified remote
                // DID/key cache. Once pinned, later conflicting proofs fail.
                did: profile.did,
                displayName: canRefreshPresentation
                    ? profile.displayName || existing.displayName
                    : existing.displayName,
                // An explicit null means the actor removed their avatar. Only
                // an omitted presentation field should preserve the cache.
                avatarUrl: !canRefreshPresentation || profile.avatarUrl === undefined
                    ? existing.avatarUrl
                    : profile.avatarUrl,
                bio: !canRefreshPresentation || profile.bio === undefined
                    ? existing.bio
                    : profile.bio,
                headerUrl: !canRefreshPresentation || profile.headerUrl === undefined
                    ? existing.headerUrl
                    : profile.headerUrl,
                website: !canRefreshPresentation || profile.website === undefined
                    ? existing.website
                    : profile.website,
                publicKey: profile.publicKey,
                isNsfw: profile.isNsfw ?? existing.isNsfw,
                ...(canRefreshPresentation && profile.profileDocument && profile.profileVersion !== undefined
                    ? {
                        profileDocumentJson: JSON.stringify(profile.profileDocument),
                        profileVersion: profile.profileVersion,
                    }
                    : {}),
                ...(profile.stuffboxBadge !== undefined
                    ? stuffboxBadgeColumns(profile.stuffboxBadge)
                    : {}),
                updatedAt: new Date(),
            })
            .where(and(
                eq(users.id, existing.id),
                eq(users.handle, profile.handle),
                eq(users.did, existing.did),
            ));
    } else {
        await database.insert(users).values({
            did: profile.did,
            handle: profile.handle,
            username: parseAccountAddress(profile.handle)!.username,
            homeDomain: parseAccountAddress(profile.handle)!.homeDomain,
            isLocalAccount: false,
            displayName: profile.displayName || profile.handle,
            avatarUrl: profile.avatarUrl || null,
            bio: profile.bio || null,
            headerUrl: profile.headerUrl || null,
            website: profile.website || null,
            publicKey: profile.publicKey,
            // Missing federation classification is never equivalent to
            // explicitly safe. Later profile hydration can set this false.
            isNsfw: profile.isNsfw ?? true,
            profileDocumentJson: profile.profileDocument
                ? JSON.stringify(profile.profileDocument)
                : null,
            profileVersion: profile.profileVersion ?? null,
            ...stuffboxBadgeColumns(profile.stuffboxBadge ?? null),
        });
    }
}

/**
 * Refresh presentation data only after a signed interaction has pinned this
 * exact handle to its self-certifying DID. Profile reads may discover an
 * account, but they cannot create or replace identity bindings by themselves.
 */
export async function refreshPinnedRemoteUserPresentation(
    profile: VerifiedRemoteProfile,
    database?: RemoteUserCacheDatabase,
): Promise<boolean> {
    const address = parseAccountAddress(profile.handle);
    if (!address) throw new Error('Remote user cache requires a fully qualified handle');
    const cache = database ?? db;
    const pinned = await cache.query.handleRegistry.findFirst({
        where: { handle: address.canonical },
    });
    if (!pinned || !pinned.identityVerified || pinned.deletedAt) return false;
    if (pinned.did !== profile.did) {
        throw new Error('Remote user identity conflicts with the verified handle binding');
    }
    if (!profile.profileDocument) return false;
    const verifiedDocument = await verifyProfileDocument(profile.profileDocument, {
        handle: address.canonical,
        did: profile.did,
        publicKey: profile.publicKey,
        displayName: profile.displayName,
        bio: profile.bio,
        avatarUrl: profile.avatarUrl,
        headerUrl: profile.headerUrl,
        website: profile.website,
    });
    if (!verifiedDocument) {
        throw new Error('Remote profile presentation is not user-signed');
    }
    await upsertRemoteUser({
        ...profile,
        handle: address.canonical,
        profileDocument: verifiedDocument,
        profileVersion: verifiedDocument.ts,
    }, {
        identityVerified: true,
    }, database);
    return true;
}

/**
 * Upsert a remote user into the local database for caching/display purposes.
 * Pass an existing transaction when identity materialization must be atomic
 * with the federation mutation that first references it.
 */
export async function upsertRemoteUser(
    profile: RemoteProfile,
    options: { identityVerified: true },
    database?: RemoteUserCacheDatabase,
): Promise<void> {
    if (!db) return;

    try {
        if (!options.identityVerified) {
            throw new Error('Remote identity cache requires a verified user proof');
        }
        const address = parseAccountAddress(profile.handle);
        if (!address) {
            throw new Error('Remote user cache requires a fully qualified handle');
        }
        if (!profile.publicKey) {
            throw new Error('Remote user signing key is required');
        }
        const normalizedPublicKey = normalizeSigningPublicKey(profile.publicKey);
        if (!normalizedPublicKey || !didKeyMatchesPublicKey(profile.did, normalizedPublicKey)) {
            throw new Error('Remote DID must be self-certifying and match its signing key');
        }
        let verifiedProfile: VerifiedRemoteProfile = {
            ...profile,
            handle: address.canonical,
            publicKey: normalizedPublicKey,
        };
        if (verifiedProfile.profileDocument) {
            const verifiedDocument = await verifyProfileDocument(verifiedProfile.profileDocument, {
                handle: verifiedProfile.handle,
                did: verifiedProfile.did,
                publicKey: verifiedProfile.publicKey,
                displayName: verifiedProfile.displayName,
                bio: verifiedProfile.bio,
                avatarUrl: verifiedProfile.avatarUrl,
                headerUrl: verifiedProfile.headerUrl,
                website: verifiedProfile.website,
            });
            if (!verifiedDocument
                || (verifiedProfile.profileVersion !== undefined
                    && verifiedProfile.profileVersion !== verifiedDocument.ts)) {
                throw new Error('Remote profile document is invalid');
            }
            verifiedProfile = {
                ...verifiedProfile,
                profileDocument: verifiedDocument,
                profileVersion: verifiedDocument.ts,
            };
        } else if (verifiedProfile.profileVersion !== undefined) {
            throw new Error('Remote profile version requires its signed document');
        }

        if (database) {
            await upsertVerifiedRemoteUser(verifiedProfile, database);
        } else {
            await withSqliteLockRetry(() => db.transaction(
                tx => upsertVerifiedRemoteUser(verifiedProfile, tx),
            ));
        }
    } catch (error) {
        console.error(`[User Cache] Failed to upsert ${profile.handle}:`, error);
        throw error;
    }
}
