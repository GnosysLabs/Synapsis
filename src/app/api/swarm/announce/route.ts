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
import { isFreshFederationTimestamp, verifySwarmRequest } from '@/lib/swarm/signature';
import type { SwarmNodeInfo } from '@/lib/swarm/types';
import { getPublicSwarmDomain, isPublicSwarmDomain } from '@/lib/swarm/node-domain';
import { FederationRequestBodyError, readLimitedJson } from '@/lib/swarm/request-body';
import { isRateLimited } from '@/lib/rate-limit';
import { federationMediaUrlSchema } from '@/lib/utils/federation';

const optionalUrlSchema = z.preprocess((value) => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, federationMediaUrlSchema.optional());

const boundedCount = z.number().int().nonnegative().max(1_000_000_000);
const announcementSchema = z.strictObject({
  domain: z.string().min(1).max(253),
  name: z.string().min(1).max(100),
  description: z.string().max(1_000).optional(),
  logoUrl: optionalUrlSchema,
  publicKey: z.string().min(1).max(16_384),
  softwareVersion: z.string().min(1).max(100),
  userCount: boundedCount,
  postCount: boundedCount,
  mediaCount: boundedCount,
  // A direct, signed announcement is authoritative. Classification is
  // mandatory so old payloads cannot silently become `safe`.
  isNsfw: z.boolean(),
  capabilities: z.array(z.enum(['handles', 'gossip', 'relay', 'search', 'interactions', 'e2ee_dm_v1'])).max(6),
  timestamp: z.string().datetime(),
});

// Schema including signature for verification
const signedAnnouncementSchema = announcementSchema.extend({
  signature: z.string().min(1).max(16_384),
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
    const body = await readLimitedJson(request);
    const data = signedAnnouncementSchema.parse(body);
    if (!isFreshFederationTimestamp(data.timestamp)) {
      return NextResponse.json({ error: 'Stale announcement payload' }, { status: 400 });
    }
    if (isRateLimited('swarm-announce-global', 120, 60 * 1_000)) {
      return NextResponse.json({ error: 'Too many announcement requests' }, { status: 429 });
    }
    
    const ourDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN;

    if (!isPublicSwarmDomain(ourDomain)) {
      return NextResponse.json(
        { error: 'This node is not configured for public swarm participation' },
        { status: 503 }
      );
    }

    if (!isPublicSwarmDomain(data.domain)) {
      return NextResponse.json(
        { error: 'Swarm nodes must use a public ICANN domain' },
        { status: 400 }
      );
    }
    
    // Don't process announcements from ourselves
    if (getPublicSwarmDomain(data.domain) === getPublicSwarmDomain(ourDomain)) {
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
    if (isRateLimited(`swarm-announce-node:${getPublicSwarmDomain(data.domain)}`, 20, 60 * 1_000)) {
      return NextResponse.json({ error: 'Too many announcement requests' }, { status: 429 });
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
      mediaCount: data.mediaCount,
      isNsfw: data.isNsfw,
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
      mediaCount: ourAnnouncement.mediaCount,
      isNsfw: ourAnnouncement.isNsfw,
      capabilities: ourAnnouncement.capabilities,
      lastSeenAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof FederationRequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
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
