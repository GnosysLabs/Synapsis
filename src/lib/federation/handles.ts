import { db, handleRegistry } from '@/db';
import { eq } from 'drizzle-orm';
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
}

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
) {
    if (!db) {
        return { added: 0, updated: 0, rejected: 0 };
    }

    let added = 0;
    let updated = 0;
    let rejected = 0;

    for (const candidate of entries) {
        const entry = canonicalHandleEntry(candidate, options.authoritativeDomain);
        const incomingUpdatedAt = authoritativeUpdatedAt(candidate.updatedAt);
        if (!entry || !entry.did.trim() || !incomingUpdatedAt) {
            rejected += 1;
            continue;
        }

        const existing = await db.query.handleRegistry.findFirst({
            where: { handle: entry.handle },
        });

        if (!existing) {
            await db.insert(handleRegistry).values({
                handle: entry.handle,
                did: entry.did.trim(),
                nodeDomain: entry.nodeDomain,
                updatedAt: incomingUpdatedAt,
            });
            added += 1;
            continue;
        }

        const identityChanged = existing.did !== entry.did.trim()
            || canonicalDomain(existing.nodeDomain) !== entry.nodeDomain;
        if (identityChanged && !options.allowIdentityChange) {
            rejected += 1;
            continue;
        }

        if (!existing.updatedAt || incomingUpdatedAt > existing.updatedAt) {
            await db.update(handleRegistry)
                .set({
                    did: entry.did.trim(),
                    nodeDomain: entry.nodeDomain,
                    updatedAt: incomingUpdatedAt,
                })
                .where(eq(handleRegistry.handle, entry.handle));
            updated += 1;
        }
    }

    return { added, updated, rejected };
}
