/**
 * Swarm Nodes Endpoint
 * 
 * GET: List all known nodes in the swarm
 * POST: Trigger discovery/sync operations (admin only)
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { parseBoundedInteger } from '@/lib/http/query';
import { requireAdmin } from '@/lib/auth/admin';
import { 
  getActiveSwarmNodes, 
  getSwarmStats,
  addSeedNode,
} from '@/lib/swarm/registry';
import { 
  announceToSeeds, 
  announceToNode,
  discoverNode,
} from '@/lib/swarm/discovery';
import { runGossipRound, gossipToNode } from '@/lib/swarm/gossip';
import { isPublicSwarmDomain } from '@/lib/swarm/node-domain';

/**
 * GET /api/swarm/nodes
 * 
 * Returns list of known swarm nodes and stats.
 * Public endpoint - anyone can see the swarm.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseBoundedInteger(searchParams.get('limit'), {
      defaultValue: 100,
      min: 1,
      max: 500,
    });
    const includeStats = searchParams.get('stats') === 'true';

    const nodes = (await getActiveSwarmNodes(limit)).map((node) => {
      // Reputation is a local defensive signal. Publishing it lets hostile
      // peers measure exactly how close they are to quarantine thresholds.
      const publicNode = { ...node };
      delete publicNode.trustScore;
      return publicNode;
    });
    
    const response: {
      nodes: typeof nodes;
      stats?: Awaited<ReturnType<typeof getSwarmStats>>;
    } = { nodes };

    if (includeStats) {
      response.stats = await getSwarmStats();
    }

    return NextResponse.json(response);
  } catch (error) {
    console.error('Swarm nodes error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch swarm nodes' },
      { status: 500 }
    );
  }
}

const actionSchema = z.object({
  action: z.enum(['announce', 'discover', 'gossip', 'addSeed']),
  domain: z.string().optional(),
  priority: z.number().optional(),
});

/**
 * POST /api/swarm/nodes
 * 
 * Admin-only endpoint to trigger swarm operations:
 * - announce: Announce to seeds or a specific node
 * - discover: Discover a specific node
 * - gossip: Run a gossip round or gossip with specific node
 * - addSeed: Add a new seed node
 */
export async function POST(request: Request) {
  try {
    await requireAdmin();

    const body = await request.json();
    const { action, domain, priority } = actionSchema.parse(body);

    if (domain && !isPublicSwarmDomain(domain)) {
      return NextResponse.json(
        { error: 'Swarm nodes must use a public ICANN domain' },
        { status: 400 }
      );
    }

    switch (action) {
      case 'announce': {
        if (domain) {
          const result = await announceToNode(domain);
          return NextResponse.json({ action, domain, ...result });
        } else {
          const result = await announceToSeeds();
          return NextResponse.json({ action, ...result });
        }
      }

      case 'discover': {
        if (!domain) {
          return NextResponse.json(
            { error: 'Domain required for discover action' },
            { status: 400 }
          );
        }
        const result = await discoverNode(domain);
        return NextResponse.json({ action, domain, ...result });
      }

      case 'gossip': {
        if (domain) {
          const result = await gossipToNode(domain);
          return NextResponse.json({ action, domain, ...result });
        } else {
          const result = await runGossipRound();
          return NextResponse.json({ action, ...result });
        }
      }

      case 'addSeed': {
        if (!domain) {
          return NextResponse.json(
            { error: 'Domain required for addSeed action' },
            { status: 400 }
          );
        }
        await addSeedNode(domain, priority);
        return NextResponse.json({ action, domain, success: true });
      }

      default:
        return NextResponse.json(
          { error: 'Unknown action' },
          { status: 400 }
        );
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid payload', details: error.issues },
        { status: 400 }
      );
    }
    if (error instanceof Error && error.message === 'Admin required') {
      return NextResponse.json({ error: 'Admin required' }, { status: 403 });
    }
    console.error('Swarm nodes POST error:', error);
    return NextResponse.json(
      { error: 'Failed to execute swarm action' },
      { status: 500 }
    );
  }
}
