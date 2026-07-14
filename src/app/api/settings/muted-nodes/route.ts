import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { mutedNodes } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth';

// GET - List muted nodes
export async function GET() {
    try {
        const currentUser = await requireAuth();

        const muted = await db.query.mutedNodes.findMany({
            where: { userId: currentUser.id },
            orderBy: (t, { desc }) => [desc(t.createdAt)],
        });

        return NextResponse.json({
            mutedNodes: muted.map(m => ({
                domain: m.nodeDomain,
                mutedAt: m.createdAt.toISOString(),
            })),
        });
    } catch (error) {
        if (error instanceof Error && error.message === 'Unauthorized') {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        console.error('Get muted nodes error:', error);
        return NextResponse.json({ error: 'Failed to get muted nodes' }, { status: 500 });
    }
}

// POST - Mute a node
export async function POST(req: NextRequest) {
    try {
        const currentUser = await requireAuth();
        const { domain } = await req.json();

        if (!domain || typeof domain !== 'string') {
            return NextResponse.json({ error: 'Domain is required' }, { status: 400 });
        }

        const normalizedDomain = domain.toLowerCase().trim();

        // Check if already muted
        const existing = await db.query.mutedNodes.findFirst({
            where: { AND: [{ userId: currentUser.id }, { nodeDomain: normalizedDomain }] },
        });

        if (existing) {
            return NextResponse.json({ muted: true, domain: normalizedDomain });
        }

        await db.insert(mutedNodes).values({
            userId: currentUser.id,
            nodeDomain: normalizedDomain,
        });

        return NextResponse.json({ muted: true, domain: normalizedDomain });
    } catch (error) {
        if (error instanceof Error && error.message === 'Unauthorized') {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        console.error('Mute node error:', error);
        return NextResponse.json({ error: 'Failed to mute node' }, { status: 500 });
    }
}

// DELETE - Unmute a node
export async function DELETE(req: NextRequest) {
    try {
        const currentUser = await requireAuth();
        const { searchParams } = new URL(req.url);
        const domain = searchParams.get('domain');

        if (!domain) {
            return NextResponse.json({ error: 'Domain is required' }, { status: 400 });
        }

        const normalizedDomain = domain.toLowerCase().trim();

        await db.delete(mutedNodes).where(
            and(
                eq(mutedNodes.userId, currentUser.id),
                eq(mutedNodes.nodeDomain, normalizedDomain)
            )
        );

        return NextResponse.json({ muted: false, domain: normalizedDomain });
    } catch (error) {
        if (error instanceof Error && error.message === 'Unauthorized') {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        console.error('Unmute node error:', error);
        return NextResponse.json({ error: 'Failed to unmute node' }, { status: 500 });
    }
}
