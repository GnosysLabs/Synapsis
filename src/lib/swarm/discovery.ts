/**
 * Swarm Discovery
 * 
 * Handles node discovery and announcement in the swarm network.
 */

import { db, users, posts, media } from '@/db';
import { isNotNull, sql } from 'drizzle-orm';
import type { SwarmAnnouncement, SwarmNodeInfo, SwarmCapability } from './types';
import { getCurrentBuildInfo } from '@/lib/version';
import { upsertSwarmNode, getSeedNodes, markNodeSuccess, markNodeFailure } from './registry';
import {
  getCanonicalSwarmSeedDomain,
  getPublicSwarmDomain,
  isPublicSwarmDomain,
  resolveNodeAssetUrl,
} from './node-domain';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { safeFederationRequest } from './safe-federation-http';
import { parseDirectNodeInfo } from './node-payload';

const PUBLIC_SWARM_DOMAIN_ERROR = 'Public swarm participation requires a real ICANN domain';

/**
 * Build this node's announcement payload
 */
export async function buildAnnouncement(): Promise<SwarmAnnouncement> {
  const domain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';
  const buildInfo = getCurrentBuildInfo();
  
  let name = 'Synapsis Node';
  let description: string | undefined;
  let logoUrl: string | undefined;
  let publicKey = '';
  let userCount = 0;
  let postCount = 0;
  let mediaCount = 0;
  let contentSequence = 0;
  // Announcements are authoritative and signed. Never publish a guessed
  // `false` classification when local configuration cannot be read.
  const isNsfw = await requireLocalNodeNsfwClassification();

  if (db) {
    // Get node info
    const node = await db.query.nodes.findFirst({
      where: { domain: domain },
    });

    if (node) {
      name = node.name;
      description = node.description ?? undefined;
      logoUrl = node.isNsfw ? undefined : resolveNodeAssetUrl(node.logoUrl, domain);
      publicKey = node.publicKey ?? '';
    }

    // Get counts
    const userResult = await db.select({ count: sql<number>`count(*)` })
      .from(users)
      .where(sql`${users.handle} NOT LIKE '%@%'`);
    const postResult = await db.select({ count: sql<number>`count(*)` }).from(posts);
    const mediaResult = await db.select({ count: sql<number>`count(*)` })
      .from(media)
      .where(isNotNull(media.postId));
    
    userCount = Number(userResult[0]?.count ?? 0);
    postCount = Number(postResult[0]?.count ?? 0);
    mediaCount = Number(mediaResult[0]?.count ?? 0);
    contentSequence = Number((await db.query.swarmContentClock.findFirst({ where: { id: 1 } }))?.sequence ?? 0);
  }

  const capabilities: SwarmCapability[] = ['handles', 'gossip', 'interactions', 'e2ee_dm_v1'];

  return {
    domain,
    name,
    description,
    logoUrl,
    publicKey,
    softwareVersion: buildInfo.commitCount !== null
      ? String(buildInfo.commitCount)
      : buildInfo.version,
    userCount,
    postCount,
    mediaCount,
    contentSequence,
    capabilities,
    isNsfw,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Announce this node to a remote node
 * 
 * SECURITY: Signs the announcement with the node's private key
 */
export async function announceToNode(targetDomain: string): Promise<{ success: boolean; error?: string }> {
  if (!isPublicSwarmDomain(process.env.NEXT_PUBLIC_NODE_DOMAIN)) {
    return { success: false, error: PUBLIC_SWARM_DOMAIN_ERROR };
  }

  const publicTargetDomain = getCanonicalSwarmSeedDomain(targetDomain);
  if (!publicTargetDomain) {
    return { success: false, error: `Invalid public swarm domain: ${targetDomain}` };
  }

  try {
    const announcement = await buildAnnouncement();
    
    // SECURITY: Sign the announcement with our private key
    const { signPayload, getNodePrivateKey } = await import('./signature');
    const privateKey = await getNodePrivateKey();
    const signature = signPayload(announcement, privateKey);
    
    const baseUrl = `https://${publicTargetDomain}`;
    const url = `${baseUrl}/api/swarm/announce`;

    const sendAnnouncement = (payload: unknown, payloadSignature: string) => (
      safeFederationRequest(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          ...(payload as Record<string, unknown>),
          signature: payloadSignature,
        }),
        timeoutMs: 8_000,
        maxResponseBytes: 256 * 1024,
      })
    );

    let response = await sendAnnouncement(announcement, signature);
    if (response.status === 400) {
      // The previous receiver schema was strict and did not know about the
      // content clock. Retry once with the legacy signed shape so mixed-version
      // nodes can still announce during a rolling upgrade.
      const legacyAnnouncement: Partial<SwarmAnnouncement> = { ...announcement };
      delete legacyAnnouncement.contentSequence;
      response = await sendAnnouncement(
        legacyAnnouncement,
        signPayload(legacyAnnouncement, privateKey),
      );
    }

    if (response.status < 200 || response.status >= 300) {
      const error = response.text();
      await markNodeFailure(publicTargetDomain);
      return { success: false, error: `HTTP ${response.status}: ${error}` };
    }

    // The remote node should respond with their info
    const remoteInfo = parseDirectNodeInfo(response.json(), publicTargetDomain);
    
    // Add/update the remote node in our registry
    await upsertSwarmNode(remoteInfo, 'direct');
    await markNodeSuccess(publicTargetDomain);

    return { success: true };
  } catch (error) {
    await markNodeFailure(publicTargetDomain);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}

/**
 * Announce to all seed nodes (bootstrap)
 */
export async function announceToSeeds(): Promise<{ 
  successful: string[]; 
  failed: { domain: string; error: string }[] 
}> {
  const seeds = await getSeedNodes();
  const ourDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN;

  if (!isPublicSwarmDomain(ourDomain)) {
    return { successful: [], failed: [] };
  }
  
  // Don't announce to ourselves
  const targetSeeds = seeds.filter(s => s !== ourDomain);
  
  const successful: string[] = [];
  const failed: { domain: string; error: string }[] = [];

  for (const seed of targetSeeds) {
    const result = await announceToNode(seed);
    if (result.success) {
      successful.push(seed);
    } else {
      failed.push({ domain: seed, error: result.error || 'Unknown error' });
    }
  }

  return { successful, failed };
}

/**
 * Fetch node info from a remote node
 */
export async function fetchNodeInfo(domain: string): Promise<SwarmNodeInfo | null> {
  const publicDomain = getPublicSwarmDomain(domain);
  if (!publicDomain) return null;

  try {
    const baseUrl = `https://${publicDomain}`;
    
    // Try the swarm endpoint first
    let response = await safeFederationRequest(`${baseUrl}/api/swarm/info`, {
      headers: { 'Accept': 'application/json' },
      timeoutMs: 8_000,
      maxResponseBytes: 256 * 1024,
    });

    if (response.status < 200 || response.status >= 300) {
      // Fall back to standard node endpoint
      response = await safeFederationRequest(`${baseUrl}/api/node`, {
        headers: { 'Accept': 'application/json' },
        timeoutMs: 8_000,
        maxResponseBytes: 256 * 1024,
      });
    }

    if (response.status < 200 || response.status >= 300) {
      return null;
    }

    return parseDirectNodeInfo(response.json(), publicDomain);
  } catch {
    return null;
  }
}

/**
 * Discover a node and add it to the registry
 */
export async function discoverNode(
  domain: string,
): Promise<{ success: boolean; isNew: boolean; error?: string }> {
  const ourDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN;
  const publicDomain = getPublicSwarmDomain(domain);

  if (!publicDomain) {
    return { success: false, isNew: false, error: `Invalid public swarm domain: ${domain}` };
  }
  
  // Don't discover ourselves
  if (publicDomain === getPublicSwarmDomain(ourDomain)) {
    return { success: false, isNew: false, error: 'Cannot discover self' };
  }

  const info = await fetchNodeInfo(publicDomain);
  
  if (!info) {
    return { success: false, isNew: false, error: 'Could not fetch node info' };
  }

  // This metadata was fetched directly from the origin over its own domain,
  // so its classification is authoritative regardless of who triggered discovery.
  const result = await upsertSwarmNode(info, 'direct');
  // Successful exact-origin discovery must advance the peer beyond the
  // admission boundary; otherwise an active peer at the boundary is never
  // selected for gossip or content synchronization again.
  await markNodeSuccess(publicDomain);
  
  return { success: true, isNew: result.isNew };
}
