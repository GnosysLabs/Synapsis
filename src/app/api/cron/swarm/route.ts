/**
 * Cron endpoint for swarm operations
 * 
 * Called periodically to run gossip rounds and maintain swarm health
 */

import { NextRequest, NextResponse } from 'next/server';
import { runGossipRound } from '@/lib/swarm/gossip';
import { announceToSeeds } from '@/lib/swarm/discovery';
import { getSwarmStats } from '@/lib/swarm/registry';

export async function POST(request: NextRequest) {
  // Verify using AUTH_SECRET to prevent unauthorized access
  const authHeader = request.headers.get('authorization');
  const authSecret = process.env.AUTH_SECRET;
  
  if (authSecret && authHeader !== `Bearer ${authSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'gossip';

  try {
    if (action === 'announce') {
      // Announce to seed nodes (used on startup)
      const result = await announceToSeeds();
      return NextResponse.json({
        success: true,
        action: 'announce',
        successful: result.successful,
        failed: result.failed,
        timestamp: new Date().toISOString(),
      });
    }

    // Default: run gossip round
    const gossipResult = await runGossipRound();
    const stats = await getSwarmStats();

    return NextResponse.json({
      success: true,
      action: 'gossip',
      gossip: gossipResult,
      swarm: stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Cron swarm processing error:', error);
    return NextResponse.json(
      { error: 'Failed to process swarm', details: String(error) },
      { status: 500 }
    );
  }
}
