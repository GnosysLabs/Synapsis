import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/admin';
import { upsertHandleEntries } from '@/lib/federation/handles';
import { FederationRequestBodyError, readLimitedJson } from '@/lib/swarm/request-body';

const payloadSchema = z.object({
    handles: z.array(z.object({
        handle: z.string().min(3).max(640),
        did: z.string().min(1).max(1_024),
        nodeDomain: z.string().min(1).max(253),
        updatedAt: z.string().datetime().optional(),
    })).min(1).max(500),
});

export async function POST(request: Request) {
    try {
        await requireAdmin();
        const body = await readLimitedJson(request);
        const data = payloadSchema.parse(body);

        const grouped = new Map<string, typeof data.handles>();
        for (const entry of data.handles) {
            const entries = grouped.get(entry.nodeDomain) ?? [];
            entries.push(entry);
            grouped.set(entry.nodeDomain, entries);
        }
        const results = await Promise.all(Array.from(grouped, ([authoritativeDomain, entries]) =>
            upsertHandleEntries(entries, { authoritativeDomain })
        ));
        const result = results.reduce((total, current) => ({
            added: total.added + current.added,
            updated: total.updated + current.updated,
            rejected: total.rejected + current.rejected,
        }), { added: 0, updated: 0, rejected: 0 });

        return NextResponse.json({
            success: true,
            added: result.added,
            updated: result.updated,
            rejected: result.rejected,
        });
    } catch (error) {
        if (error instanceof FederationRequestBodyError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        if (error instanceof z.ZodError) {
            return NextResponse.json({ error: 'Invalid payload', details: error.issues }, { status: 400 });
        }
        if (error instanceof Error && error.message === 'Admin required') {
            return NextResponse.json({ error: 'Admin required' }, { status: 403 });
        }
        console.error('Handle ingest error:', error);
        return NextResponse.json({ error: 'Failed to ingest handles' }, { status: 500 });
    }
}
