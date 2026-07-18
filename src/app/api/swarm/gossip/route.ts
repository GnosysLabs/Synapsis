/**
 * Swarm Gossip Endpoint
 * 
 * POST: Exchange node and handle information with other nodes
 * 
 * SECURITY: All requests must be cryptographically signed by the sender node.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { establishDirectGossipPeer, processGossip } from '@/lib/swarm/gossip';
import { markNodeSuccess } from '@/lib/swarm/registry';
import { isFreshFederationTimestamp, verifySwarmRequest } from '@/lib/swarm/signature';
import type { SwarmGossipPayload } from '@/lib/swarm/types';
import { getPublicSwarmDomain, isPublicSwarmDomain } from '@/lib/swarm/node-domain';
import { FederationRequestBodyError, readLimitedJson } from '@/lib/swarm/request-body';
import { isRateLimited } from '@/lib/rate-limit';
import { federationMediaUrlSchema } from '@/lib/utils/federation';

const handleSchema = z.strictObject({
  handle: z.string().min(3).max(640),
  did: z.string().min(1).max(1_024),
  nodeDomain: z.string().min(1).max(253),
  updatedAt: z.string().datetime().optional(),
});

const boundedCount = z.number().int().nonnegative().max(1_000_000_000);
const nodeInfoSchema = z.strictObject({
  domain: z.string().min(1).max(253),
  name: z.string().max(100).optional(),
  description: z.string().max(1_000).optional(),
  logoUrl: federationMediaUrlSchema.optional(),
  publicKey: z.string().max(16_384).optional(),
  softwareVersion: z.string().max(100).optional(),
  userCount: boundedCount.optional(),
  postCount: boundedCount.optional(),
  mediaCount: boundedCount.optional(),
  isNsfw: z.boolean().optional(),
  capabilities: z.array(z.enum(['handles', 'gossip', 'relay', 'search', 'interactions', 'e2ee_dm_v1'])).max(6).optional(),
  lastSeenAt: z.string().datetime().optional(),
});

const gossipPayloadSchema = z.strictObject({
  sender: z.string().min(1).max(253),
  nodes: z.array(nodeInfoSchema).max(100),
  handles: z.array(handleSchema).max(500).optional(),
  timestamp: z.string().datetime(),
  since: z.string().datetime().optional(),
});

// Schema including signature for verification
const signedGossipSchema = gossipPayloadSchema.extend({
  signature: z.string().min(1).max(16_384),
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
    const body = await readLimitedJson(request);
    const data = signedGossipSchema.parse(body);
    if (!isFreshFederationTimestamp(data.timestamp)) {
      return NextResponse.json({ error: 'Stale gossip payload' }, { status: 400 });
    }
    const ourDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN;

    if (!isPublicSwarmDomain(ourDomain)) {
      return NextResponse.json(
        { error: 'This node is not configured for public swarm participation' },
        { status: 503 }
      );
    }

    if (!isPublicSwarmDomain(data.sender)) {
      return NextResponse.json(
        { error: 'Swarm nodes must use a public ICANN domain' },
        { status: 400 }
      );
    }
    
    // Don't process gossip from ourselves
    if (getPublicSwarmDomain(data.sender) === getPublicSwarmDomain(ourDomain)) {
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
    if (isRateLimited('swarm-gossip-authenticated-global', 600, 60 * 1_000)) {
      return NextResponse.json({ error: 'Too many gossip requests' }, { status: 429 });
    }
    if (isRateLimited(`swarm-gossip-node:${getPublicSwarmDomain(data.sender)}`, 30, 60 * 1_000)) {
      return NextResponse.json({ error: 'Too many gossip requests' }, { status: 429 });
    }

    console.log(`[Swarm] Gossip from ${data.sender}: ${data.nodes.length} nodes, ${data.handles?.length || 0} handles`);

    if (!await establishDirectGossipPeer(payload.nodes, data.sender)) {
      return NextResponse.json(
        { error: 'Gossip sender did not provide a complete exact-origin identity' },
        { status: 400 },
      );
    }

    // Process the incoming gossip and build our response. The sender has
    // already been established above; relayed entries remain hints only.
    const response = await processGossip(payload as SwarmGossipPayload, {
      senderAuthenticated: false,
    });
    
    // Mark the sender as successfully contacted
    await markNodeSuccess(data.sender);

    console.log(`[Swarm] Gossip response to ${data.sender}: ${response.nodes.length} nodes, ${response.handles?.length || 0} handles`);

    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof FederationRequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
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
