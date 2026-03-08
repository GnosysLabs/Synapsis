/**
 * Swarm Info Endpoint
 * 
 * GET: Returns this node's public swarm information
 */

import { NextResponse } from 'next/server';
import { buildAnnouncement } from '@/lib/swarm/discovery';

/**
 * GET /api/swarm/info
 * 
 * Returns this node's public information for the swarm.
 * Used by other nodes during discovery.
 */
export async function GET() {
  try {
    const announcement = await buildAnnouncement();
    
    return NextResponse.json({
      domain: announcement.domain,
      name: announcement.name,
      description: announcement.description,
      logoUrl: announcement.logoUrl,
      publicKey: announcement.publicKey,
      softwareVersion: announcement.softwareVersion,
      userCount: announcement.userCount,
      postCount: announcement.postCount,
      isNsfw: announcement.isNsfw,
      capabilities: announcement.capabilities,
      lastSeenAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Swarm info error:', error);
    return NextResponse.json(
      { error: 'Failed to get node info' },
      { status: 500 }
    );
  }
}
