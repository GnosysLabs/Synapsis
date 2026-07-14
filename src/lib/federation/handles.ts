import { db, handleRegistry } from '@/db';
import { eq } from 'drizzle-orm';

export type HandleEntry = {
    handle: string;
    did: string;
    nodeDomain: string;
    updatedAt?: string;
};

export const normalizeHandle = (handle: string) =>
    handle.toLowerCase().replace(/^@/, '').trim();

export async function upsertHandleEntries(entries: HandleEntry[]) {
    if (!db) {
        return { added: 0, updated: 0 };
    }

    let added = 0;
    let updated = 0;

    for (const entry of entries) {
        const cleanHandle = normalizeHandle(entry.handle);
        if (!cleanHandle || !entry.did || !entry.nodeDomain) {
            continue;
        }

        const existing = await db.query.handleRegistry.findFirst({
            where: { handle: cleanHandle },
        });

        // If no timestamp provided, treat it as "now" but be careful
        // Actually, if it's missing, it might be old data. 
        // But if it comes from the authoritative source, we might trust it.
        const incomingUpdatedAt = entry.updatedAt ? new Date(entry.updatedAt) : new Date();

        if (!existing) {
            await db.insert(handleRegistry).values({
                handle: cleanHandle,
                did: entry.did,
                nodeDomain: entry.nodeDomain,
                updatedAt: incomingUpdatedAt,
            });
            added += 1;
            continue;
        }

        if (!existing.updatedAt || incomingUpdatedAt > existing.updatedAt) {
            await db.update(handleRegistry)
                .set({
                    did: entry.did,
                    nodeDomain: entry.nodeDomain,
                    updatedAt: incomingUpdatedAt,
                })
                .where(eq(handleRegistry.handle, cleanHandle));
            updated += 1;
        }
    }

    return { added, updated };
}
