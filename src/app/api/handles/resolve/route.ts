import { NextResponse } from 'next/server';
import { db, handleRegistry } from '@/db';
import {
    liveHandleRegistryEntryWhere,
    normalizeHandle,
    upsertRemoteHandleHints,
} from '@/lib/federation/handles';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { safeFederationRequest } from '@/lib/swarm/safe-federation-http';
import { getPublicSwarmDomain, normalizeNodeDomain } from '@/lib/swarm/node-domain';

const handleParamSchema = z.string().min(3).max(40).regex(/^[a-zA-Z0-9_]+(@[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]\.[a-zA-Z]{2,})?$/, 'Invalid handle format');

const parseHandleWithDomain = (handle: string) => {
    const clean = normalizeHandle(handle);
    const parts = clean.split('@').filter(Boolean);
    if (parts.length === 2) {
        return { handle: parts[0], domain: parts[1] };
    }
    return null;
};

export async function GET(request: Request) {
    try {
        if (!db) {
            return NextResponse.json({ error: 'Database not available' }, { status: 503 });
        }

        const { searchParams } = new URL(request.url);
        const handleParamRaw = searchParams.get('handle');

        if (!handleParamRaw) {
            return NextResponse.json({ error: 'Handle is required' }, { status: 400 });
        }

        // Validate handle format
        const handleValidation = handleParamSchema.safeParse(handleParamRaw);
        if (!handleValidation.success) {
            return NextResponse.json(
                { error: 'Invalid handle format', details: handleValidation.error.issues },
                { status: 400 }
            );
        }
        const handleParam = handleValidation.data;

        const parsed = parseHandleWithDomain(handleParam);
        const canonicalDomain = parsed ? getPublicSwarmDomain(parsed.domain) : null;
        if (parsed && !canonicalDomain) {
            return NextResponse.json({ error: 'Handle node is invalid' }, { status: 400 });
        }
        const lookupHandle = parsed
            ? `${parsed.handle}@${canonicalDomain}`
            : normalizeHandle(handleParam);
        const localDomain = normalizeNodeDomain(
            process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
        );
        const [localEntry] = await db.select().from(handleRegistry).where(and(
            eq(handleRegistry.handle, lookupHandle),
            liveHandleRegistryEntryWhere(),
        )).limit(1);

        if (localEntry && normalizeNodeDomain(localEntry.nodeDomain)
            === (canonicalDomain || localDomain)) {
            return NextResponse.json({
                handle: localEntry.handle,
                did: localEntry.did,
                nodeDomain: localEntry.nodeDomain,
                updatedAt: localEntry.updatedAt,
            });
        }

        if (!parsed) {
            return NextResponse.json({ error: 'Handle not found' }, { status: 404 });
        }

        const url = new URL('/.well-known/synapsis-handles', `https://${canonicalDomain}`);
        url.searchParams.set('handle', parsed.handle);

        const res = await safeFederationRequest(url.toString(), {
            timeoutMs: 8_000,
            maxResponseBytes: 256 * 1024,
        });
        if (res.status < 200 || res.status >= 300) {
            return NextResponse.json({ error: 'Handle not found' }, { status: 404 });
        }

        const data = res.json() as { handles?: unknown };
        const rawEntry = Array.isArray(data.handles) ? data.handles[0] : null;

        const entrySchema = z.object({
            handle: z.string().min(3).max(30),
            did: z.string().min(1).max(1_024),
            nodeDomain: z.string().min(1).max(253),
            updatedAt: z.string().datetime().optional(),
        });
        const parsedEntry = entrySchema.safeParse(rawEntry);
        if (!parsedEntry.success
            || normalizeHandle(parsedEntry.data.handle) !== parsed.handle
            || getPublicSwarmDomain(parsedEntry.data.nodeDomain) !== canonicalDomain) {
            return NextResponse.json({ error: 'Handle not found' }, { status: 404 });
        }

        await upsertRemoteHandleHints([parsedEntry.data], canonicalDomain!);

        return NextResponse.json({
            ...parsedEntry.data,
            handle: `${parsed.handle}@${canonicalDomain}`,
            nodeDomain: canonicalDomain,
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return NextResponse.json(
                { error: 'Invalid input', details: error.issues },
                { status: 400 }
            );
        }
        console.error('Handle resolve error:', error);
        return NextResponse.json({ error: 'Failed to resolve handle' }, { status: 500 });
    }
}
