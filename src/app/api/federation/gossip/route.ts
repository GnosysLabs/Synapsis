import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/admin';
import { upsertHandleEntries } from '@/lib/federation/handles';
import { safeFederationRequest } from '@/lib/swarm/safe-federation-http';

const gossipSchema = z.object({
    nodes: z.array(z.string().min(1)).min(1),
    since: z.string().optional(),
});

export async function POST(request: Request) {
    try {
        await requireAdmin();

        const body = await request.json();
        const data = gossipSchema.parse(body);

        const results = [];

        for (const node of data.nodes) {
            const baseUrl = node.startsWith('http') ? node : `https://${node}`;
            const url = new URL('/.well-known/synapsis-handles', baseUrl);
            if (data.since) {
                url.searchParams.set('since', data.since);
            }

            try {
                const res = await safeFederationRequest(url.toString(), {
                    timeoutMs: 8_000,
                    maxResponseBytes: 256 * 1024,
                });
                if (res.status < 200 || res.status >= 300) {
                    results.push({ node, success: false, error: `HTTP ${res.status}` });
                    continue;
                }

                const payload = res.json() as { handles?: unknown };
                const handles = Array.isArray(payload.handles) ? payload.handles : [];
                const merged = await upsertHandleEntries(handles);

                results.push({
                    node,
                    success: true,
                    added: merged.added,
                    updated: merged.updated,
                });
            } catch {
                results.push({ node, success: false, error: 'Fetch failed' });
            }
        }

        return NextResponse.json({ results });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return NextResponse.json({ error: 'Invalid payload', details: error.issues }, { status: 400 });
        }
        if (error instanceof Error && error.message === 'Admin required') {
            return NextResponse.json({ error: 'Admin required' }, { status: 403 });
        }
        console.error('Gossip error:', error);
        return NextResponse.json({ error: 'Failed to gossip handles' }, { status: 500 });
    }
}
