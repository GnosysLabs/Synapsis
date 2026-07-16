/**
 * Swarm Inbox Endpoint
 * 
 * POST: Receive posts from users on other swarm nodes that local users follow
 * 
 * When a user on another Synapsis node creates a post, it gets pushed here
 * for their followers on this node.
 */

import { NextResponse } from 'next/server';

/**
 * POST /api/swarm/inbox
 * 
 * DEPRECATED: This endpoint is disabled.
 * We now use real-time pull-based federation via /api/swarm/timeline
 * instead of push-based caching.
 */
export async function POST() {
  return NextResponse.json({
    error: 'This endpoint is deprecated. Swarm uses real-time pull-based federation.',
  }, { status: 410 }); // 410 Gone
}
