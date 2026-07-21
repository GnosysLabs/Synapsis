import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/admin';
import { unblockNode, upsertBlockedNode } from '@/lib/swarm/node-blocklist';
import { discoverNode } from '@/lib/swarm/discovery';
import { requireCanonicalAccountHomeDomain } from '@/lib/identity/account-address';

const mutateNodeSchema = z.object({
  action: z.enum(['block', 'unblock']),
  domain: z.string().min(1),
  reason: z.string().max(500).optional().nullable(),
});

export async function GET() {
  try {
    await requireAdmin();

    const nodes = await db.query.swarmNodes.findMany({
      orderBy: (swarmNodes, { desc }) => [desc(swarmNodes.isBlocked), desc(swarmNodes.blockedAt), desc(swarmNodes.lastSeenAt)],
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
        quarantineCompletedAt: node.quarantineCompletedAt,
        quarantineError: node.quarantineError,
        remoteAccessDeniedAt: node.remoteAccessDeniedAt,
        remoteAccessDeniedReason: node.remoteAccessDeniedReason,
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
    const domain = requireCanonicalAccountHomeDomain(data.domain);
    const localDomain = requireCanonicalAccountHomeDomain(
      process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
    );

    if (domain === localDomain) {
      return NextResponse.json({ error: 'Cannot block this node itself' }, { status: 400 });
    }

    if (data.action === 'block') {
      const result = await upsertBlockedNode(domain, data.reason || null);
      if (!result) {
        return NextResponse.json({ error: 'Node not found' }, { status: 404 });
      }
      return NextResponse.json(result);
    }

    const unblocked = await unblockNode(domain);
    if (!unblocked) {
      return NextResponse.json({ error: 'Node not found' }, { status: 404 });
    }

    // Unblocking only opens the perimeter. A direct origin fetch must verify
    // reachability and key continuity before the peer becomes active again.
    let reconnect: Awaited<ReturnType<typeof discoverNode>>;
    try {
      reconnect = await discoverNode(domain);
    } catch (error) {
      reconnect = {
        success: false,
        isNew: false,
        error: error instanceof Error ? error.message : 'Direct node verification failed',
      };
    }
    const node = await db.query.swarmNodes.findFirst({ where: { domain } }) ?? unblocked;
    return NextResponse.json({
      node,
      reconnect: {
        verified: reconnect.success,
        error: reconnect.error || null,
      },
      relationshipsRestored: false,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid payload', details: error.issues }, { status: 400 });
    }
    console.error('Admin update nodes error:', error);
    return NextResponse.json({ error: 'Failed to update node blocklist' }, { status: 500 });
  }
}
