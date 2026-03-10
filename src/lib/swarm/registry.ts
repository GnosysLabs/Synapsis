/**
 * Swarm Registry
 * 
 * Manages the local registry of known swarm nodes.
 */

import { db, swarmNodes, swarmSeeds, swarmSyncLog } from '@/db';
import { eq, desc, and, gt, lt, sql } from 'drizzle-orm';
import type { SwarmNodeInfo, SwarmCapability, SwarmSyncResult } from './types';
import { SWARM_CONFIG, DEFAULT_SEED_NODES } from './types';
import { normalizeNodeDomain } from './node-blocklist';

/**
 * Get or create a swarm node entry
 */
export async function upsertSwarmNode(
  node: SwarmNodeInfo,
  discoveredVia?: string
): Promise<{ isNew: boolean }> {
  if (!db) {
    return { isNew: false };
  }

  const existing = await db.query.swarmNodes.findFirst({
    where: eq(swarmNodes.domain, normalizeNodeDomain(node.domain)),
  });

  const normalizedDomain = normalizeNodeDomain(node.domain);

  const capabilities = node.capabilities ? JSON.stringify(node.capabilities) : null;

  if (!existing) {
    await db.insert(swarmNodes).values({
      domain: normalizedDomain,
      name: node.name,
      description: node.description,
      logoUrl: node.logoUrl,
      publicKey: node.publicKey,
      softwareVersion: node.softwareVersion,
      userCount: node.userCount,
      postCount: node.postCount,
      isNsfw: node.isNsfw ?? false,
      discoveredVia,
      capabilities,
      lastSeenAt: node.lastSeenAt ? new Date(node.lastSeenAt) : new Date(),
    });
    return { isNew: true };
  }

  // Update existing node
  await db.update(swarmNodes)
    .set({
      name: node.name ?? existing.name,
      description: node.description ?? existing.description,
      logoUrl: node.logoUrl ?? existing.logoUrl,
      publicKey: node.publicKey ?? existing.publicKey,
      softwareVersion: node.softwareVersion ?? existing.softwareVersion,
      userCount: node.userCount ?? existing.userCount,
      postCount: node.postCount ?? existing.postCount,
      isNsfw: node.isNsfw ?? existing.isNsfw,
      capabilities: capabilities ?? existing.capabilities,
      lastSeenAt: new Date(),
      consecutiveFailures: 0,
      isActive: existing.isBlocked ? false : true,
      updatedAt: new Date(),
    })
    .where(eq(swarmNodes.domain, normalizedDomain));

  return { isNew: false };
}

/**
 * Bulk upsert swarm nodes from gossip
 */
export async function upsertSwarmNodes(
  nodes: SwarmNodeInfo[],
  discoveredVia: string
): Promise<{ added: number; updated: number }> {
  if (!db || nodes.length === 0) {
    return { added: 0, updated: 0 };
  }

  let added = 0;
  let updated = 0;

  // Filter out our own domain
  const ourDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN;
  const filteredNodes = nodes.filter(n => n.domain !== ourDomain);
  const normalizedOurDomain = ourDomain ? normalizeNodeDomain(ourDomain) : null;
  const safeNodes = filteredNodes.filter(n => normalizeNodeDomain(n.domain) !== normalizedOurDomain);

  for (const node of safeNodes) {
    const result = await upsertSwarmNode(node, discoveredVia);
    if (result.isNew) {
      added++;
    } else {
      updated++;
    }
  }

  return { added, updated };
}

/**
 * Get all active swarm nodes
 */
export async function getActiveSwarmNodes(limit = 100): Promise<SwarmNodeInfo[]> {
  if (!db) {
    return [];
  }

  const nodes = await db.query.swarmNodes.findMany({
    where: and(
      eq(swarmNodes.isActive, true),
      eq(swarmNodes.isBlocked, false),
    ),
    orderBy: [desc(swarmNodes.lastSeenAt)],
    limit,
  });

  return nodes.map(nodeToInfo);
}

/**
 * Get nodes for gossip (random selection of active nodes)
 */
export async function getNodesForGossip(count: number): Promise<SwarmNodeInfo[]> {
  if (!db) {
    return [];
  }

  // Get active nodes with decent trust scores, ordered randomly
  const nodes = await db.query.swarmNodes.findMany({
    where: and(
      eq(swarmNodes.isActive, true),
      eq(swarmNodes.isBlocked, false),
      gt(swarmNodes.trustScore, 20)
    ),
    orderBy: sql`RANDOM()`,
    limit: count,
  });

  return nodes.map(nodeToInfo);
}

/**
 * Get nodes updated since a timestamp (for incremental sync)
 */
export async function getNodesSince(since: Date, limit = 100): Promise<SwarmNodeInfo[]> {
  if (!db) {
    return [];
  }

  const nodes = await db.query.swarmNodes.findMany({
    where: and(
      gt(swarmNodes.updatedAt, since),
      eq(swarmNodes.isBlocked, false),
    ),
    orderBy: [desc(swarmNodes.updatedAt)],
    limit,
  });

  return nodes.map(nodeToInfo);
}

/**
 * Mark a node as having failed contact
 * 
 * @throws Error if database operation fails (after logging)
 */
export async function markNodeFailure(domain: string): Promise<void> {
  if (!db) return;

  try {
    const node = await db.query.swarmNodes.findFirst({
      where: eq(swarmNodes.domain, domain),
    });

    if (!node) return;

    const newFailures = node.consecutiveFailures + 1;
    const newTrust = Math.max(
      SWARM_CONFIG.minTrustScore,
      node.trustScore + SWARM_CONFIG.trustScoreOnFailure
    );
    const isActive = newFailures < SWARM_CONFIG.maxConsecutiveFailures;

    await db.update(swarmNodes)
      .set({
        consecutiveFailures: newFailures,
        trustScore: newTrust,
        isActive: node.isBlocked ? false : isActive,
        updatedAt: new Date(),
      })
      .where(eq(swarmNodes.domain, domain));
  } catch (error) {
    console.error(`[Swarm] Failed to mark node failure for ${domain}:`, error);
    throw error;
  }
}

/**
 * Mark a node as successfully contacted
 * 
 * @throws Error if database operation fails (after logging)
 */
export async function markNodeSuccess(domain: string): Promise<void> {
  if (!db) return;

  try {
    const node = await db.query.swarmNodes.findFirst({
      where: eq(swarmNodes.domain, domain),
    });

    if (!node) return;

    const newTrust = Math.min(
      SWARM_CONFIG.maxTrustScore,
      node.trustScore + SWARM_CONFIG.trustScoreOnSuccess
    );

    await db.update(swarmNodes)
      .set({
        consecutiveFailures: 0,
        trustScore: newTrust,
        isActive: node.isBlocked ? false : true,
        lastSeenAt: new Date(),
        lastSyncAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(swarmNodes.domain, domain));
  } catch (error) {
    console.error(`[Swarm] Failed to mark node success for ${domain}:`, error);
    throw error;
  }
}

/**
 * Log a sync operation
 * 
 * @throws Error if database operation fails (after logging)
 */
export async function logSync(
  remoteDomain: string,
  direction: 'push' | 'pull',
  result: SwarmSyncResult
): Promise<void> {
  if (!db) return;

  try {
    await db.insert(swarmSyncLog).values({
      remoteDomain,
      direction,
      nodesReceived: result.nodesReceived,
      nodesSent: result.nodesSent,
      handlesReceived: result.handlesReceived,
      handlesSent: result.handlesSent,
      success: result.success,
      errorMessage: result.error,
      durationMs: result.durationMs,
    });
  } catch (error) {
    console.error(`[Swarm] Failed to log sync for ${remoteDomain}:`, error);
    throw error;
  }
}

/**
 * Get seed nodes (with fallback to defaults)
 */
export async function getSeedNodes(): Promise<string[]> {
  if (!db) {
    return [...DEFAULT_SEED_NODES];
  }

  const seeds = await db.query.swarmSeeds.findMany({
    where: eq(swarmSeeds.isEnabled, true),
    orderBy: [swarmSeeds.priority],
  });

  if (seeds.length === 0) {
    return [...DEFAULT_SEED_NODES];
  }

  return seeds.map(s => s.domain);
}

/**
 * Add a seed node
 */
export async function addSeedNode(domain: string, priority = 100): Promise<void> {
  if (!db) return;

  await db.insert(swarmSeeds)
    .values({ domain, priority })
    .onConflictDoUpdate({
      target: swarmSeeds.domain,
      set: { priority, isEnabled: true },
    });
}

/**
 * Get swarm statistics
 */
export async function getSwarmStats() {
  if (!db) {
    return {
      totalNodes: 0,
      activeNodes: 0,
      totalUsers: 0,
      totalPosts: 0,
    };
  }

  const allNodes = await db.query.swarmNodes.findMany();
  const activeNodes = allNodes.filter(n => n.isActive);

  const totalUsers = activeNodes.reduce((sum, n) => sum + (n.userCount || 0), 0);
  const totalPosts = activeNodes.reduce((sum, n) => sum + (n.postCount || 0), 0);

  return {
    totalNodes: allNodes.length,
    activeNodes: activeNodes.length,
    totalUsers,
    totalPosts,
  };
}

// Helper to convert DB node to SwarmNodeInfo
function nodeToInfo(node: typeof swarmNodes.$inferSelect): SwarmNodeInfo {
  return {
    domain: node.domain,
    name: node.name ?? undefined,
    description: node.description ?? undefined,
    logoUrl: node.logoUrl ?? undefined,
    publicKey: node.publicKey ?? undefined,
    softwareVersion: node.softwareVersion ?? undefined,
    userCount: node.userCount ?? undefined,
    postCount: node.postCount ?? undefined,
    capabilities: node.capabilities ? JSON.parse(node.capabilities) : undefined,
    isNsfw: node.isNsfw,
    lastSeenAt: node.lastSeenAt.toISOString(),
  };
}
