import { NextRequest, NextResponse } from 'next/server';
import { db, swarmNodes } from '@/db';
import { desc } from 'drizzle-orm';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/admin';
import { normalizeNodeDomain, unblockNode, upsertBlockedNode } from '@/lib/swarm/node-blocklist';

const mutateNodeSchema = z.object({
  action: z.enum(['block', 'unblock']),
  domain: z.string().min(1),
  reason: z.string().max(500).optional().nullable(),
});

export async function GET() {
  try {
    await requireAdmin();

    const nodes = await db.query.swarmNodes.findMany({
      orderBy: [desc(swarmNodes.isBlocked), desc(swarmNodes.blockedAt), desc(swarmNodes.lastSeenAt)],
    });

    return NextResponse.json({
      nodes: nodes.map((node) => ({
        id: node.id,
        domain: node.domain,
        name: node.name,
        description: node.description,
        isActive: node.isActive,
        isBlocked: node.isBlocked,
        blockReason: node.blockReason,
        blockedAt: node.blockedAt,
        lastSeenAt: node.lastSeenAt,
        trustScore: node.trustScore,
        isNsfw: node.isNsfw,
      })),
    });
  } catch (error) {
    console.error('Admin get nodes error:', error);
    return NextResponse.json({ error: 'Failed to load nodes' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    await requireAdmin();

    const body = await request.json();
    const data = mutateNodeSchema.parse(body);
    const domain = normalizeNodeDomain(data.domain);
    const localDomain = normalizeNodeDomain(process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:3000');

    if (domain === localDomain) {
      return NextResponse.json({ error: 'Cannot block this node itself' }, { status: 400 });
    }

    const node = data.action === 'block'
      ? await upsertBlockedNode(domain, data.reason || null)
      : await unblockNode(domain);

    if (!node) {
      return NextResponse.json({ error: 'Node not found' }, { status: 404 });
    }

    return NextResponse.json({ node });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid payload', details: error.issues }, { status: 400 });
    }
    console.error('Admin update nodes error:', error);
    return NextResponse.json({ error: 'Failed to update node blocklist' }, { status: 500 });
  }
}
