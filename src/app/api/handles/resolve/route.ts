import { NextResponse } from 'next/server';
import { db } from '@/db';
import { normalizeHandle, upsertHandleEntries } from '@/lib/federation/handles';
import { z } from 'zod';

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
        const lookupHandle = parsed ? parsed.handle : normalizeHandle(handleParam);
        const localEntry = await db.query.handleRegistry.findFirst({
            where: { handle: lookupHandle },
        });

        if (localEntry) {
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

        const url = new URL('/.well-known/synapsis-handles', `https://${parsed.domain}`);
        url.searchParams.set('handle', parsed.handle);

        const res = await fetch(url.toString());
        if (!res.ok) {
            return NextResponse.json({ error: 'Handle not found' }, { status: 404 });
        }

        const data = await res.json();
        const entry = Array.isArray(data?.handles) ? data.handles[0] : null;

        if (!entry) {
            return NextResponse.json({ error: 'Handle not found' }, { status: 404 });
        }

        await upsertHandleEntries([entry]);

        return NextResponse.json(entry);
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
