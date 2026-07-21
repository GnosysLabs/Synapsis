import { NextResponse } from 'next/server';
import { db, handleRegistry } from '@/db';
import { desc } from 'drizzle-orm';
import { resolveAccountAddress } from '@/lib/identity/account-address';
import {
    getCanonicalSwarmSeedDomain,
    normalizeNodeDomain,
} from '@/lib/swarm/node-domain';

export async function GET(request: Request) {
    try {
        if (!db) {
            return NextResponse.json({ handles: [] });
        }

        const { searchParams } = new URL(request.url);
        const handleParam = searchParams.get('handle');
        const sinceParam = searchParams.get('since');
        const limit = Math.min(parseInt(searchParams.get('limit') || '100'), 500);
        const configuredDomain = normalizeNodeDomain(
            process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
        );
        const localDomain = getCanonicalSwarmSeedDomain(configuredDomain) ?? configuredDomain;

        if (handleParam) {
            const address = resolveAccountAddress(handleParam, localDomain);
            if (!address || address.homeDomain !== localDomain) {
                return NextResponse.json({ handles: [] });
            }
            const entry = await db.query.handleRegistry.findFirst({
                where: { AND: [{ handle: address.canonical }, { nodeDomain: localDomain }] },
            });

            if (!entry) {
                return NextResponse.json({ handles: [] });
            }

            const entryAddress = resolveAccountAddress(entry.handle, entry.nodeDomain);
            if (!entryAddress || entryAddress.homeDomain !== localDomain) {
                return NextResponse.json({ handles: [] });
            }

            return NextResponse.json({
                handles: [{
                    handle: entryAddress.canonical,
                    did: entry.did,
                    nodeDomain: entryAddress.homeDomain,
                    updatedAt: entry.updatedAt,
                }],
            });
        }

        const sinceDate = sinceParam ? new Date(sinceParam) : null;
        const entries = await db.query.handleRegistry.findMany({
            where: {
                AND: [
                    { nodeDomain: localDomain },
                    ...(sinceDate ? [{ updatedAt: { gt: sinceDate } }] : []),
                ],
            },
            orderBy: () => [desc(handleRegistry.updatedAt)],
            limit,
        });

        return NextResponse.json({
            handles: entries.flatMap((entry) => {
                const address = resolveAccountAddress(entry.handle, entry.nodeDomain);
                return address && address.homeDomain === localDomain
                    ? [{
                        handle: address.canonical,
                        did: entry.did,
                        nodeDomain: address.homeDomain,
                        updatedAt: entry.updatedAt,
                    }]
                    : [];
            }),
        });
    } catch (error) {
        console.error('Handle export error:', error);
        return NextResponse.json({ error: 'Failed to export handles' }, { status: 500 });
    }
}
