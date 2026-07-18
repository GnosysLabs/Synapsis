import { db, handleRegistry } from '@/db';
import { and, eq, lt, or } from 'drizzle-orm';
import { getPublicSwarmDomain, normalizeNodeDomain } from '@/lib/swarm/node-domain';

export type HandleEntry = {
    handle: string;
    did: string;
    nodeDomain: string;
    updatedAt?: string;
};

export const normalizeHandle = (handle: string) =>
    handle.toLowerCase().replace(/^@/, '').trim();

export interface HandleMergeOptions {
    /** The exact node that directly supplied and is authoritative for these entries. */
    authoritativeDomain: string;
    /** Local account recovery may deliberately rotate its self-certifying DID. */
    allowIdentityChange?: boolean;
    /** Only local account ownership, never node directory data, verifies identity. */
    identityVerified?: boolean;
}

type HandleDirectoryDatabase = Pick<typeof db, 'insert' | 'query'>;

function canonicalDomain(value: string): string | null {
    const normalized = normalizeNodeDomain(value);
    const developmentLoopback = process.env.NODE_ENV !== 'production'
        && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(normalized);
    return developmentLoopback ? normalized : getPublicSwarmDomain(normalized);
}

export function canonicalHandleEntry(
    entry: HandleEntry,
    authoritativeDomain: string,
): (HandleEntry & { handle: string; nodeDomain: string }) | null {
    const authority = canonicalDomain(authoritativeDomain);
    const entryDomain = canonicalDomain(entry.nodeDomain);
    if (!authority || !entryDomain || authority !== entryDomain) return null;

    const normalized = normalizeHandle(entry.handle);
    const parts = normalized.split('@');
    if (parts.length > 2 || !parts[0]) return null;
    if (parts.length === 2 && canonicalDomain(parts[1]) !== entryDomain) return null;

    const bareHandle = parts[0];
    if (!/^[a-z0-9_]{3,30}$/i.test(bareHandle)) return null;
    const localDomain = canonicalDomain(
        process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
    );

    return {
        ...entry,
        handle: entryDomain === localDomain ? bareHandle : `${bareHandle}@${entryDomain}`,
        nodeDomain: entryDomain,
    };
}

function authoritativeUpdatedAt(value: string | undefined): Date | null {
    if (!value) return new Date();
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) return null;
    if (parsed.getTime() > Date.now() + 5 * 60 * 1000) return null;
    return parsed;
}

export async function upsertHandleEntries(
    entries: HandleEntry[],
    options: HandleMergeOptions,
    database: HandleDirectoryDatabase = db,
) {
    let added = 0;
    let updated = 0;
    let rejected = 0;
    const localDomain = canonicalDomain(
        process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
    );

    for (const candidate of entries) {
        const entry = canonicalHandleEntry(candidate, options.authoritativeDomain);
        const incomingUpdatedAt = authoritativeUpdatedAt(candidate.updatedAt);
        if (!entry || !entry.did.trim() || !incomingUpdatedAt) {
            rejected += 1;
            continue;
        }

        const incomingDid = entry.did.trim();
        const incomingVerified = options.identityVerified === true;
        // Remote node/directory data is never sufficient to verify a user.
        // Signed remote actor proofs use pinVerifiedFederatedActorIdentity.
        if (incomingVerified && entry.nodeDomain !== localDomain) {
            rejected += 1;
            continue;
        }

        const existing = await database.query.handleRegistry.findFirst({
            where: { handle: entry.handle },
        });

        const sameIdentity = and(
            eq(handleRegistry.did, incomingDid),
            eq(handleRegistry.nodeDomain, entry.nodeDomain),
        );
        const isNewer = lt(handleRegistry.updatedAt, incomingUpdatedAt);
        const canRotateVerifiedLocalIdentity = incomingVerified
            && options.allowIdentityChange === true;
        const updateWhere = canRotateVerifiedLocalIdentity
            ? undefined
            : incomingVerified
                ? or(
                    eq(handleRegistry.identityVerified, false),
                    and(
                        eq(handleRegistry.identityVerified, true),
                        sameIdentity,
                        isNewer,
                    ),
                )
                : and(
                    eq(handleRegistry.identityVerified, false),
                    sameIdentity,
                    isNewer,
                );

        const statement = database.insert(handleRegistry).values({
            handle: entry.handle,
            did: incomingDid,
            nodeDomain: entry.nodeDomain,
            identityVerified: incomingVerified,
            updatedAt: incomingUpdatedAt,
        }).onConflictDoUpdate({
            target: handleRegistry.handle,
            set: {
                did: incomingDid,
                nodeDomain: entry.nodeDomain,
                identityVerified: incomingVerified,
                updatedAt: incomingUpdatedAt,
            },
            ...(updateWhere ? { setWhere: updateWhere } : {}),
        }).returning({
            did: handleRegistry.did,
            nodeDomain: handleRegistry.nodeDomain,
            identityVerified: handleRegistry.identityVerified,
        });
        const [merged] = await statement;

        if (merged) {
            if (existing) updated += 1;
            else added += 1;
            continue;
        }

        // A no-op can mean an identical stale entry or that another writer
        // won the race. Re-read before deciding whether this was a conflict.
        const current = await database.query.handleRegistry.findFirst({
            where: { handle: entry.handle },
        });
        const sameCurrentIdentity = current?.did === incomingDid
            && canonicalDomain(current.nodeDomain) === entry.nodeDomain;
        const verificationSatisfied = !incomingVerified || current?.identityVerified === true;
        if (!sameCurrentIdentity || !verificationSatisfied) rejected += 1;
    }

    return { added, updated, rejected };
}
