/**
 * Swarm Gossip Endpoint
 * 
 * POST: Exchange node and handle information with other nodes
 * 
 * SECURITY: All requests must be cryptographically signed by the sender node.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { processGossip } from '@/lib/swarm/gossip';
import { markNodeSuccess } from '@/lib/swarm/registry';
import { verifySwarmRequest } from '@/lib/swarm/signature';
import type { SwarmGossipPayload } from '@/lib/swarm/types';

const handleSchema = z.object({
  handle: z.string(),
  did: z.string(),
  nodeDomain: z.string(),
  updatedAt: z.string().optional(),
});

const nodeInfoSchema = z.object({
  domain: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  logoUrl: z.string().optional(),
  publicKey: z.string().optional(),
  softwareVersion: z.string().optional(),
  userCount: z.number().optional(),
  postCount: z.number().optional(),
  isNsfw: z.boolean().optional(),
  capabilities: z.array(z.enum(['handles', 'gossip', 'relay', 'search', 'interactions'])).optional(),
  lastSeenAt: z.string().optional(),
});

const gossipPayloadSchema = z.object({
  sender: z.string().min(1),
  nodes: z.array(nodeInfoSchema),
  handles: z.array(handleSchema).optional(),
  timestamp: z.string(),
  since: z.string().optional(),
});

// Schema including signature for verification
const signedGossipSchema = gossipPayloadSchema.extend({
  signature: z.string(),
});

/**
 * POST /api/swarm/gossip
 * 
 * Receives gossip from another node and responds with our own data.
 * This is the core of the epidemic protocol - nodes exchange what they know.
 * 
 * SECURITY: All gossip requests must be signed by the sender node.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const data = signedGossipSchema.parse(body);
    
    const ourDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN;
    
    // Don't process gossip from ourselves
    if (data.sender === ourDomain) {
      return NextResponse.json(
        { error: 'Cannot gossip with self' },
        { status: 400 }
      );
    }

    // SECURITY: Verify the node signature before processing
    const { signature, ...payload } = data;
    const isValid = await verifySwarmRequest(payload, signature, data.sender);

    if (!isValid) {
      console.warn(`[Swarm] Invalid signature for gossip from ${data.sender}`);
      return NextResponse.json(
        { error: 'Invalid signature' },
        { status: 403 }
      );
    }

    console.log(`[Swarm] Gossip from ${data.sender}: ${data.nodes.length} nodes, ${data.handles?.length || 0} handles`);

    // Process the incoming gossip and build our response
    const response = await processGossip(payload as SwarmGossipPayload);
    
    // Mark the sender as successfully contacted
    await markNodeSuccess(data.sender);

    console.log(`[Swarm] Gossip response to ${data.sender}: ${response.nodes.length} nodes, ${response.handles?.length || 0} handles`);

    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid gossip payload', details: error.issues },
        { status: 400 }
      );
    }
    console.error('Swarm gossip error:', error);
    return NextResponse.json(
      { error: 'Failed to process gossip' },
      { status: 500 }
    );
  }
}
