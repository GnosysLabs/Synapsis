/**
 * Swarm Announce Endpoint
 * 
 * POST: Receive announcements from other nodes joining the swarm
 * 
 * SECURITY: All requests must be cryptographically signed by the sender node.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { upsertSwarmNode } from '@/lib/swarm/registry';
import { buildAnnouncement } from '@/lib/swarm/discovery';
import { verifySwarmRequest } from '@/lib/swarm/signature';
import type { SwarmNodeInfo } from '@/lib/swarm/types';

const optionalUrlSchema = z.preprocess((value) => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().url().optional());

const announcementSchema = z.object({
  domain: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  logoUrl: optionalUrlSchema,
  publicKey: z.string().optional(),
  softwareVersion: z.string().optional(),
  userCount: z.number().optional(),
  postCount: z.number().optional(),
  capabilities: z.array(z.enum(['handles', 'gossip', 'relay', 'search', 'interactions'])).optional(),
  timestamp: z.string().optional(),
});

// Schema including signature for verification
const signedAnnouncementSchema = announcementSchema.extend({
  signature: z.string(),
});

/**
 * POST /api/swarm/announce
 * 
 * Receives an announcement from another node and responds with our info.
 * This is how nodes introduce themselves to the swarm.
 * 
 * SECURITY: All announcement requests must be signed by the sender node.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const data = signedAnnouncementSchema.parse(body);
    
    const ourDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN;
    
    // Don't process announcements from ourselves
    if (data.domain === ourDomain) {
      return NextResponse.json(
        { error: 'Cannot announce to self' },
        { status: 400 }
      );
    }

    // SECURITY: Verify the node signature before processing
    const { signature, ...payload } = data;
    const isValid = await verifySwarmRequest(payload, signature, data.domain);

    if (!isValid) {
      console.warn(`[Swarm] Invalid signature for announcement from ${data.domain}`);
      return NextResponse.json(
        { error: 'Invalid signature' },
        { status: 403 }
      );
    }

    // Add/update the announcing node in our registry
    const nodeInfo: SwarmNodeInfo = {
      domain: data.domain,
      name: data.name,
      description: data.description,
      logoUrl: data.logoUrl,
      publicKey: data.publicKey,
      softwareVersion: data.softwareVersion,
      userCount: data.userCount,
      postCount: data.postCount,
      capabilities: data.capabilities,
      lastSeenAt: new Date().toISOString(),
    };

    const { isNew } = await upsertSwarmNode(nodeInfo, 'announcement');

    console.log(`[Swarm] ${isNew ? 'New' : 'Known'} node announced: ${data.domain}`);

    // Respond with our own info
    const ourAnnouncement = await buildAnnouncement();
    
    return NextResponse.json({
      domain: ourAnnouncement.domain,
      name: ourAnnouncement.name,
      description: ourAnnouncement.description,
      logoUrl: ourAnnouncement.logoUrl,
      publicKey: ourAnnouncement.publicKey,
      softwareVersion: ourAnnouncement.softwareVersion,
      userCount: ourAnnouncement.userCount,
      postCount: ourAnnouncement.postCount,
      capabilities: ourAnnouncement.capabilities,
      lastSeenAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid announcement payload', details: error.issues },
        { status: 400 }
      );
    }
    console.error('Swarm announce error:', error);
    return NextResponse.json(
      { error: 'Failed to process announcement' },
      { status: 500 }
    );
  }
}
