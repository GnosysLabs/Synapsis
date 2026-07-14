import { NextResponse } from 'next/server';
import { db, handleRegistry } from '@/db';
import { desc } from 'drizzle-orm';
import { normalizeHandle } from '@/lib/federation/handles';

export async function GET(request: Request) {
    try {
        if (!db) {
            return NextResponse.json({ handles: [] });
        }

        const { searchParams } = new URL(request.url);
        const handleParam = searchParams.get('handle');
        const sinceParam = searchParams.get('since');
        const limit = Math.min(parseInt(searchParams.get('limit') || '100'), 500);

        if (handleParam) {
            const cleanHandle = normalizeHandle(handleParam);
            const entry = await db.query.handleRegistry.findFirst({
                where: { handle: cleanHandle },
            });

            if (!entry) {
                return NextResponse.json({ handles: [] });
            }

            return NextResponse.json({
                handles: [{
                    handle: entry.handle,
                    did: entry.did,
                    nodeDomain: entry.nodeDomain,
                    updatedAt: entry.updatedAt,
                }],
            });
        }

        const sinceDate = sinceParam ? new Date(sinceParam) : null;
        const entries = await db.query.handleRegistry.findMany({
            where: sinceDate ? { updatedAt: { gt: sinceDate } } : undefined,
            orderBy: () => [desc(handleRegistry.updatedAt)],
            limit,
        });

        return NextResponse.json({
            handles: entries.map((entry) => ({
                handle: entry.handle,
                did: entry.did,
                nodeDomain: entry.nodeDomain,
                updatedAt: entry.updatedAt,
            })),
        });
    } catch (error) {
        console.error('Handle export error:', error);
        return NextResponse.json({ error: 'Failed to export handles' }, { status: 500 });
    }
}
