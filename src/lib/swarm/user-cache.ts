import { db, users } from '@/db';
import { normalizeSigningPublicKey } from '@/lib/crypto/did-key';
import { eq } from 'drizzle-orm';

export interface RemoteProfile {
    handle: string;
    displayName: string;
    avatarUrl?: string | null;
    did: string;
    isBot?: boolean;
    publicKey?: string;
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
export async function upsertRemoteUser(profile: RemoteProfile): Promise<void> {
    if (!db) return;

    try {
        if (!profile.handle.includes('@')) {
            throw new Error('Remote user cache requires a fully qualified handle');
        }

        const [byDid, byHandle] = await Promise.all([
            db.query.users.findFirst({ where: { did: profile.did } }),
            db.query.users.findFirst({ where: { handle: profile.handle } }),
        ]);
        if (byDid && byHandle && byDid.id !== byHandle.id) {
            throw new Error('Remote user identity conflicts with the existing cache');
        }
        const existing = byDid || byHandle;

        if (existing) {
            if (!existing.handle.includes('@') && !existing.id.startsWith('swarm:')) {
                throw new Error('Federation cannot modify a local user');
            }
            if (existing.did !== profile.did || existing.handle !== profile.handle) {
                throw new Error('Remote user DID or handle changed unexpectedly');
            }
            if (profile.publicKey && existing.publicKey
                && !signingKeysEqual(profile.publicKey, existing.publicKey)) {
                throw new Error('Remote user signing key changed unexpectedly');
            }
            const shouldUpdateKey = profile.publicKey && !existing.publicKey;

            await db.update(users)
                .set({
                    displayName: profile.displayName || existing.displayName,
                    avatarUrl: profile.avatarUrl || existing.avatarUrl,
                    isBot: profile.isBot ?? existing.isBot,
                    publicKey: shouldUpdateKey ? profile.publicKey : existing.publicKey,
                    updatedAt: new Date(),
                })
                .where(eq(users.id, existing.id));
        } else {
            if (!profile.publicKey) throw new Error('Remote user signing key is required');
            // Create new placeholder user
            await db.insert(users).values({
                did: profile.did,
                handle: profile.handle, // user@domain
                displayName: profile.displayName || profile.handle,
                avatarUrl: profile.avatarUrl || null,
                isBot: profile.isBot || false,
                publicKey: profile.publicKey,
                // Note: nodeId is null for remote placeholders unless we specifically link it
            });
        }
    } catch (error) {
        console.error(`[User Cache] Failed to upsert ${profile.handle}:`, error);
        throw error;
    }
}
