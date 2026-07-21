import { db, handleRegistry } from '@/db';
import { and, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import { withSqliteLockRetry } from '@/lib/db/sqlite-lock-retry';
import {
    getCanonicalSwarmSeedDomain,
    getPublicSwarmDomain,
    normalizeNodeDomain,
} from '@/lib/swarm/node-domain';

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
    /** Bound how many previously unknown hints this merge may persist. */
    maxNewEntries?: number;
}

type HandleDirectoryDatabase = Pick<typeof db, 'insert' | 'query'>;

const MAX_STORED_REMOTE_HANDLE_HINTS_PER_NODE = 200;
const MAX_STORED_REMOTE_HANDLE_HINTS_GLOBAL = 5_000;
const MAX_REMOTE_HANDLE_HINTS_PER_MERGE = 50;
const REMOTE_HANDLE_HINT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const REMOTE_HANDLE_HINT_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const REMOTE_HANDLE_HINT_PRUNE_BATCH_SIZE = 100;
let nextRemoteHandleHintPruneAt = 0;

type HandleHintMaintenanceDatabase = Pick<typeof db, 'run'>;

/** Verified identities do not expire; unverified routing hints do. */
export function liveHandleRegistryEntryWhere(now = Date.now()) {
    return and(
        isNull(handleRegistry.deletedAt),
        or(
            eq(handleRegistry.identityVerified, true),
            gte(handleRegistry.updatedAt, new Date(now - REMOTE_HANDLE_HINT_TTL_MS)),
        ),
    );
}

/**
 * Delete at most one fixed-size batch of expired hints when maintenance is due.
 * Read paths enforce the same TTL, so maintenance lag can never revive a hint.
 */
export async function pruneExpiredRemoteHandleHints(options: {
    database?: HandleHintMaintenanceDatabase;
    now?: number;
    force?: boolean;
} = {}): Promise<boolean> {
    const now = options.now ?? Date.now();
    if (!options.force && now < nextRemoteHandleHintPruneAt) return false;
    nextRemoteHandleHintPruneAt = now + REMOTE_HANDLE_HINT_PRUNE_INTERVAL_MS;
    const database = options.database ?? db;

    try {
        await withSqliteLockRetry(() => database.run(sql`
            DELETE FROM ${handleRegistry}
            WHERE rowid IN (
                SELECT rowid
                FROM ${handleRegistry}
                WHERE ${handleRegistry.identityVerified} = false
                  AND ${handleRegistry.deletedAt} IS NULL
                  AND ${handleRegistry.updatedAt} < ${new Date(now - REMOTE_HANDLE_HINT_TTL_MS)}
                ORDER BY ${handleRegistry.updatedAt} ASC
                LIMIT ${REMOTE_HANDLE_HINT_PRUNE_BATCH_SIZE}
            )
        `));
        return true;
    } catch (error) {
        console.warn('[Swarm] Could not prune stale remote handle hints', error);
        return false;
    }
}

function canonicalDomain(value: string): string | null {
    const normalized = normalizeNodeDomain(value);
    const developmentLoopback = process.env.NODE_ENV !== 'production'
        && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(normalized);
    const publicDomain = getPublicSwarmDomain(normalized);
    return developmentLoopback
        ? normalized
        : publicDomain
            ? getCanonicalSwarmSeedDomain(publicDomain) ?? publicDomain
            : null;
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
    return {
        ...entry,
        handle: `${bareHandle}@${entryDomain}`,
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
    const maxNewEntries = options.maxNewEntries === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Math.floor(options.maxNewEntries));
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
        if (!existing && added >= maxNewEntries) {
            rejected += 1;
            continue;
        }

        const sameIdentity = and(
            eq(handleRegistry.did, incomingDid),
            eq(handleRegistry.nodeDomain, entry.nodeDomain),
        );
        const isNewer = lt(handleRegistry.updatedAt, incomingUpdatedAt);
        const canRotateVerifiedLocalIdentity = incomingVerified
            && options.allowIdentityChange === true;
        const updateWhere = canRotateVerifiedLocalIdentity
            ? isNull(handleRegistry.deletedAt)
            : incomingVerified
                ? and(
                    isNull(handleRegistry.deletedAt),
                    or(
                        eq(handleRegistry.identityVerified, false),
                        and(
                            eq(handleRegistry.identityVerified, true),
                            sameIdentity,
                            isNewer,
                        ),
                    ),
                  )
                : and(
                    isNull(handleRegistry.deletedAt),
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
            setWhere: updateWhere,
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

/**
 * Persist bounded, expiring routing hints supplied by a remote node.
 * These rows remain unverified and can never authorize an actor action.
 */
export async function upsertRemoteHandleHints(
    entries: HandleEntry[],
    authoritativeDomain: string,
) {
    const now = Date.now();
    await pruneExpiredRemoteHandleHints({ now });
    const authority = canonicalDomain(authoritativeDomain);
    if (!authority || entries.length === 0) {
        return { added: 0, updated: 0, rejected: entries.length };
    }

    const [nodeCounts, globalCounts] = await Promise.all([
        db.select({ count: sql<number>`count(*)` })
            .from(handleRegistry)
            .where(and(
                eq(handleRegistry.identityVerified, false),
                eq(handleRegistry.nodeDomain, authority),
                isNull(handleRegistry.deletedAt),
            )),
        db.select({ count: sql<number>`count(*)` })
            .from(handleRegistry)
            .where(and(
                eq(handleRegistry.identityVerified, false),
                isNull(handleRegistry.deletedAt),
            )),
    ]);
    const remainingForNode = Math.max(
        0,
        MAX_STORED_REMOTE_HANDLE_HINTS_PER_NODE - Number(nodeCounts[0]?.count ?? 0),
    );
    const remainingGlobal = Math.max(
        0,
        MAX_STORED_REMOTE_HANDLE_HINTS_GLOBAL - Number(globalCounts[0]?.count ?? 0),
    );
    const admittedEntries = entries.slice(0, MAX_REMOTE_HANDLE_HINTS_PER_MERGE);
    const merged = await upsertHandleEntries(admittedEntries, {
        authoritativeDomain: authority,
        maxNewEntries: Math.min(remainingForNode, remainingGlobal),
    });

    return {
        ...merged,
        rejected: merged.rejected + Math.max(0, entries.length - admittedEntries.length),
    };
}
