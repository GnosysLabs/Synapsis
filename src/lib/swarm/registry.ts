/**
 * Swarm Registry
 * 
 * Manages the local registry of known swarm nodes.
 */

import { db, media, posts, swarmNodes, swarmSeeds, swarmSyncLog, users } from '@/db';
import { eq, isNotNull, sql } from 'drizzle-orm';
import type { SwarmNodeInfo, SwarmSyncResult } from './types';
import { SWARM_CONFIG, DEFAULT_SEED_NODES } from './types';
import {
  getCanonicalSwarmSeedDomain,
  getPublicSwarmDomain,
  isPublicSwarmDomain,
} from './node-domain';
import { mergePermanentNodeNsfwClassification } from '@/lib/node/nsfw-classification';

interface NetworkStatNode {
  isActive: boolean;
  userCount: number | null;
  postCount: number | null;
  mediaCount: number | null;
}

interface LocalNetworkStats {
  users: number;
  posts: number;
  media: number;
}

export function aggregateSwarmStats(
  publicNodes: NetworkStatNode[],
  local: LocalNetworkStats,
  includeLocalNode: boolean,
) {
  const activeNodes = publicNodes.filter(node => node.isActive);
  const localNodeOffset = includeLocalNode ? 1 : 0;

  return {
    totalNodes: publicNodes.length + localNodeOffset,
    // Keep this as the active peer count; the scheduler uses zero to trigger seed recovery.
    activeNodes: activeNodes.length,
    totalUsers: activeNodes.reduce((sum, node) => sum + (node.userCount || 0), 0)
      + (includeLocalNode ? local.users : 0),
    totalPosts: activeNodes.reduce((sum, node) => sum + (node.postCount || 0), 0)
      + (includeLocalNode ? local.posts : 0),
    totalMedia: activeNodes.reduce((sum, node) => sum + (node.mediaCount || 0), 0)
      + (includeLocalNode ? local.media : 0),
  };
}

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

  const normalizedDomain = getPublicSwarmDomain(node.domain);
  if (!normalizedDomain) {
    throw new Error(`Swarm nodes must use a public ICANN domain: ${node.domain}`);
  }

  const existing = await db.query.swarmNodes.findFirst({
    where: { domain: normalizedDomain },
  });

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
      mediaCount: node.mediaCount,
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
      mediaCount: node.mediaCount ?? existing.mediaCount,
      isNsfw: mergePermanentNodeNsfwClassification(existing.isNsfw, node.isNsfw),
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
  const normalizedOurDomain = getPublicSwarmDomain(ourDomain);
  const safeNodes = filteredNodes.filter(n =>
    isPublicSwarmDomain(n.domain) && getPublicSwarmDomain(n.domain) !== normalizedOurDomain
  );

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
export async function getActiveSwarmNodes(limit?: number): Promise<SwarmNodeInfo[]> {
  if (!db) {
    return [];
  }

  const nodes = await db.query.swarmNodes.findMany({
    where: { AND: [{ isActive: true }, { isBlocked: false }] },
    orderBy: (swarmNodes, { desc }) => [desc(swarmNodes.lastSeenAt)],
    ...(limit === undefined ? {} : { limit }),
  });

  return nodes.filter((node) => isPublicSwarmDomain(node.domain)).map(nodeToInfo);
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
    where: { AND: [{ isActive: true }, { isBlocked: false }, { trustScore: { gt: 20 } }] },
    orderBy: () => sql`RANDOM()`,
    limit: count,
  });

  return nodes.filter((node) => isPublicSwarmDomain(node.domain)).map(nodeToInfo);
}

/**
 * Get nodes updated since a timestamp (for incremental sync)
 */
export async function getNodesSince(since: Date, limit = 100): Promise<SwarmNodeInfo[]> {
  if (!db) {
    return [];
  }

  const nodes = await db.query.swarmNodes.findMany({
    where: { AND: [{ updatedAt: { gt: since } }, { isBlocked: false }] },
    orderBy: (swarmNodes, { desc }) => [desc(swarmNodes.updatedAt)],
    limit,
  });

  return nodes.filter((node) => isPublicSwarmDomain(node.domain)).map(nodeToInfo);
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
      where: { domain: domain },
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
      where: { domain: domain },
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
    where: { isEnabled: true },
    orderBy: (swarmSeeds) => [swarmSeeds.priority],
  });

  const publicSeeds = Array.from(new Set(
    seeds
      .map((seed) => getCanonicalSwarmSeedDomain(seed.domain))
      .filter((domain): domain is string => domain !== null)
  ));

  return publicSeeds.length > 0
    ? publicSeeds
    : DEFAULT_SEED_NODES.filter(isPublicSwarmDomain);
}

/**
 * Add a seed node
 */
export async function addSeedNode(domain: string, priority = 100): Promise<void> {
  if (!db) return;

  const normalizedDomain = getCanonicalSwarmSeedDomain(domain);
  if (!normalizedDomain) {
    throw new Error(`Seed nodes must use a public ICANN domain: ${domain}`);
  }

  await db.insert(swarmSeeds)
    .values({ domain: normalizedDomain, priority })
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
      totalMedia: 0,
    };
  }

  const allNodes = await db.query.swarmNodes.findMany();
  const publicNodes = allNodes.filter(n => isPublicSwarmDomain(n.domain));

  const [localUsers, localPosts, localMedia] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(users)
      .where(sql`${users.handle} NOT LIKE '%@%'`),
    db.select({ count: sql<number>`count(*)` }).from(posts),
    db.select({ count: sql<number>`count(*)` }).from(media).where(isNotNull(media.postId)),
  ]);

  const hasPublicLocalNode = isPublicSwarmDomain(process.env.NEXT_PUBLIC_NODE_DOMAIN);
  return aggregateSwarmStats(publicNodes, {
    users: Number(localUsers[0]?.count ?? 0),
    posts: Number(localPosts[0]?.count ?? 0),
    media: Number(localMedia[0]?.count ?? 0),
  }, hasPublicLocalNode);
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
    mediaCount: node.mediaCount ?? undefined,
    capabilities: node.capabilities ? JSON.parse(node.capabilities) : undefined,
    isNsfw: node.isNsfw,
    lastSeenAt: node.lastSeenAt.toISOString(),
  };
}
