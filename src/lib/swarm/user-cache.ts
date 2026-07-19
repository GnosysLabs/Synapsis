import { db } from '@/db';
import { users } from '@/db/schema';
import {
    didKeyMatchesPublicKey,
    normalizeSigningPublicKey,
} from '@/lib/crypto/did-key';
import { and, eq } from 'drizzle-orm';
import { withSqliteLockRetry } from '@/lib/db/sqlite-lock-retry';

export interface RemoteProfile {
    handle: string;
    displayName: string;
    avatarUrl?: string | null;
    did: string;
    publicKey?: string;
    isNsfw?: boolean;
}

function signingKeysEqual(left: string, right: string): boolean {
    const normalizedLeft = normalizeSigningPublicKey(left);
    const normalizedRight = normalizeSigningPublicKey(right);
    return normalizedLeft && normalizedRight
        ? normalizedLeft === normalizedRight
        : left === right;
}

/**
 * Upsert a remote user into the local database for caching/display purposes.
 * 
 * @throws Error if database operation fails (after logging)
 */
export async function upsertRemoteUser(
    profile: RemoteProfile,
    options: { identityVerified: true },
): Promise<void> {
    if (!db) return;

    try {
        if (!options.identityVerified) {
            throw new Error('Remote identity cache requires a verified user proof');
        }
        if (!profile.handle.includes('@')) {
            throw new Error('Remote user cache requires a fully qualified handle');
        }
        if (!profile.publicKey) {
            throw new Error('Remote user signing key is required');
        }
        const normalizedPublicKey = normalizeSigningPublicKey(profile.publicKey);
        if (!normalizedPublicKey || !didKeyMatchesPublicKey(profile.did, normalizedPublicKey)) {
            throw new Error('Remote DID must be self-certifying and match its signing key');
        }
        const verifiedProfile = {
            ...profile,
            handle: profile.handle.toLowerCase().replace(/^@/, ''),
            publicKey: normalizedPublicKey,
        };

        await withSqliteLockRetry(() => db.transaction(async (tx) => {
            // The durable verified registry is the identity authority. Legacy
            // remote user rows were populated from node directory hints and may
            // contain synthetic did:swarm:* values; a valid user proof may
            // replace those hints only after this exact handle was pinned.
            const pinned = await tx.query.handleRegistry.findFirst({
                where: {
                    AND: [
                        { handle: verifiedProfile.handle },
                        { did: verifiedProfile.did },
                        { identityVerified: true },
                    ],
                },
            });
            if (!pinned) {
                throw new Error('Remote user identity is not verified for this handle');
            }

            const [byDid, byHandle] = await Promise.all([
                tx.query.users.findFirst({ where: { did: verifiedProfile.did } }),
                tx.query.users.findFirst({ where: { handle: verifiedProfile.handle } }),
            ]);
            if (byDid && byHandle && byDid.id !== byHandle.id) {
                throw new Error('Remote user identity conflicts with the existing cache');
            }
            if (byDid && byDid.handle !== verifiedProfile.handle) {
                throw new Error('Remote DID is already bound to another handle');
            }
            const existing = byHandle || byDid;

            if (existing) {
                if (!existing.handle.includes('@')) {
                    throw new Error('Federation cannot modify a local user');
                }
                if (existing.handle !== verifiedProfile.handle) {
                    throw new Error('Remote user handle changed unexpectedly');
                }

                const replacingLegacyHint = existing.did !== verifiedProfile.did;
                if (!replacingLegacyHint
                    && existing.publicKey
                    && !signingKeysEqual(verifiedProfile.publicKey, existing.publicKey)) {
                    throw new Error('Remote user signing key changed unexpectedly');
                }

                await tx.update(users)
                    .set({
                        // A verified handle pin may replace a legacy, unverified
                        // remote DID/key cache. Once pinned, later conflicting
                        // proofs fail before this function is reached.
                        did: verifiedProfile.did,
                        displayName: verifiedProfile.displayName || existing.displayName,
                        avatarUrl: verifiedProfile.avatarUrl || existing.avatarUrl,
                        publicKey: verifiedProfile.publicKey,
                        isNsfw: verifiedProfile.isNsfw ?? existing.isNsfw,
                        updatedAt: new Date(),
                    })
                    .where(and(
                        eq(users.id, existing.id),
                        eq(users.handle, verifiedProfile.handle),
                        eq(users.did, existing.did),
                    ));
            } else {
                // Create new placeholder user from the verified identity.
                await tx.insert(users).values({
                    did: verifiedProfile.did,
                    handle: verifiedProfile.handle, // user@domain
                    displayName: verifiedProfile.displayName || verifiedProfile.handle,
                    avatarUrl: verifiedProfile.avatarUrl || null,
                    publicKey: verifiedProfile.publicKey,
                    // Missing federation classification is never equivalent to
                    // explicitly safe. Later profile hydration can set this false.
                    isNsfw: verifiedProfile.isNsfw ?? true,
                    // Note: nodeId is null for remote placeholders unless we specifically link it
                });
            }
        }));
    } catch (error) {
        console.error(`[User Cache] Failed to upsert ${profile.handle}:`, error);
        throw error;
    }
}
