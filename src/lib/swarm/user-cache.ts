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

export interface RemoteProfile {
    handle: string;
    displayName: string;
    avatarUrl?: string | null;
    did: string;
    publicKey?: string;
    isNsfw?: boolean;
    stuffboxBadge?: StuffboxBadge | null;
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

        await database.update(users)
            .set({
                // A verified handle pin may replace a legacy, unverified remote
                // DID/key cache. Once pinned, later conflicting proofs fail.
                did: profile.did,
                displayName: profile.displayName || existing.displayName,
                avatarUrl: profile.avatarUrl || existing.avatarUrl,
                publicKey: profile.publicKey,
                isNsfw: profile.isNsfw ?? existing.isNsfw,
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
            publicKey: profile.publicKey,
            // Missing federation classification is never equivalent to
            // explicitly safe. Later profile hydration can set this false.
            isNsfw: profile.isNsfw ?? true,
            ...stuffboxBadgeColumns(profile.stuffboxBadge ?? null),
        });
    }
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
        const verifiedProfile: VerifiedRemoteProfile = {
            ...profile,
            handle: address.canonical,
            publicKey: normalizedPublicKey,
        };

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
