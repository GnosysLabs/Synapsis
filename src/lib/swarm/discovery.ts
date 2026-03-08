/**
 * Swarm Discovery
 * 
 * Handles node discovery and announcement in the swarm network.
 */

import { db, nodes, users, posts } from '@/db';
import { eq, sql } from 'drizzle-orm';
import type { SwarmAnnouncement, SwarmNodeInfo, SwarmCapability } from './types';
import { upsertSwarmNode, getSeedNodes, markNodeSuccess, markNodeFailure } from './registry';

function normalizeOptionalUrl(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build this node's announcement payload
 */
export async function buildAnnouncement(): Promise<SwarmAnnouncement> {
  const domain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:3000';
  
  let name = 'Synapsis Node';
  let description: string | undefined;
  let logoUrl: string | undefined;
  let publicKey = '';
  let userCount = 0;
  let postCount = 0;
  let isNsfw = false;

  if (db) {
    // Get node info
    const node = await db.query.nodes.findFirst({
      where: eq(nodes.domain, domain),
    });

    if (node) {
      name = node.name;
      description = node.description ?? undefined;
      logoUrl = normalizeOptionalUrl(node.logoUrl);
      publicKey = node.publicKey ?? '';
      isNsfw = node.isNsfw;
    }

    // Get counts
    const userResult = await db.select({ count: sql<number>`count(*)` }).from(users);
    const postResult = await db.select({ count: sql<number>`count(*)` }).from(posts);
    
    userCount = Number(userResult[0]?.count ?? 0);
    postCount = Number(postResult[0]?.count ?? 0);
  }

  const capabilities: SwarmCapability[] = ['handles', 'gossip', 'interactions'];

  return {
    domain,
    name,
    description,
    logoUrl,
    publicKey,
    softwareVersion: '0.1.0', // TODO: Get from package.json
    userCount,
    postCount,
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
  try {
    const announcement = await buildAnnouncement();
    
    // SECURITY: Sign the announcement with our private key
    const { signPayload, getNodePrivateKey } = await import('./signature');
    const privateKey = await getNodePrivateKey();
    const signature = signPayload(announcement, privateKey);
    
    const signedAnnouncement = {
      ...announcement,
      signature,
    };
    
    const baseUrl = targetDomain.startsWith('http') ? targetDomain : `https://${targetDomain}`;
    const url = `${baseUrl}/api/swarm/announce`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(signedAnnouncement),
    });

    if (!response.ok) {
      const error = await response.text();
      await markNodeFailure(targetDomain);
      return { success: false, error: `HTTP ${response.status}: ${error}` };
    }

    // The remote node should respond with their info
    const remoteInfo = await response.json() as SwarmNodeInfo;
    
    // Add/update the remote node in our registry
    await upsertSwarmNode(remoteInfo, 'direct');
    await markNodeSuccess(targetDomain);

    return { success: true };
  } catch (error) {
    await markNodeFailure(targetDomain);
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
  try {
    const baseUrl = domain.startsWith('http') ? domain : `https://${domain}`;
    
    // Try the swarm endpoint first
    let response = await fetch(`${baseUrl}/api/swarm/info`, {
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      // Fall back to standard node endpoint
      response = await fetch(`${baseUrl}/api/node`, {
        headers: { 'Accept': 'application/json' },
      });
    }

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    
    return {
      domain: data.domain || domain,
      name: data.name,
      description: data.description,
      logoUrl: data.logoUrl,
      publicKey: data.publicKey,
      softwareVersion: data.softwareVersion,
      userCount: data.userCount,
      postCount: data.postCount,
      capabilities: data.capabilities,
      isNsfw: data.isNsfw,
    };
  } catch {
    return null;
  }
}

/**
 * Discover a node and add it to the registry
 */
export async function discoverNode(
  domain: string, 
  discoveredVia?: string
): Promise<{ success: boolean; isNew: boolean; error?: string }> {
  const ourDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN;
  
  // Don't discover ourselves
  if (domain === ourDomain) {
    return { success: false, isNew: false, error: 'Cannot discover self' };
  }

  const info = await fetchNodeInfo(domain);
  
  if (!info) {
    return { success: false, isNew: false, error: 'Could not fetch node info' };
  }

  const result = await upsertSwarmNode(info, discoveredVia);
  
  return { success: true, isNew: result.isNew };
}
