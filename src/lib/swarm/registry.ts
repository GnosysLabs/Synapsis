/**
 * Swarm Registry
 * 
 * Manages the local registry of known swarm nodes.
 */

import { db, media, posts, swarmNodes, swarmSeeds, swarmSyncLog, users } from '@/db';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { SwarmNodeInfo, SwarmSyncResult } from './types';
import { SWARM_CONFIG, DEFAULT_SEED_NODES } from './types';
import {
  getCanonicalSwarmSeedDomain,
  getPublicSwarmDomain,
  isPublicSwarmDomain,
} from './node-domain';
import { mergePermanentNodeNsfwClassification } from '@/lib/node/nsfw-classification';
import { normalizeSwarmNodePublicKey } from './node-public-key';

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

  const classificationIsAuthoritative = discoveredVia === 'announcement' || discoveredVia === 'direct';
  const incomingKey = normalizeSwarmNodePublicKey(node.publicKey);
  if (classificationIsAuthoritative && (!incomingKey || typeof node.isNsfw !== 'boolean')) {
    throw new Error(`Direct node identity is incomplete for ${normalizedDomain}`);
  }

  const capabilities = node.capabilities ? JSON.stringify(node.capabilities) : null;
  const incomingClassificationKnown = classificationIsAuthoritative
    && typeof node.isNsfw === 'boolean';
  const incomingIsNsfw = incomingClassificationKnown ? node.isNsfw === true : false;

  if (!existing) {
    // Gossip is only a discovery hint. It must not make a Sybil node active or
    // allow a third party to assign that node's metadata or signing key.
    await db.insert(swarmNodes).values({
      domain: normalizedDomain,
      name: classificationIsAuthoritative ? node.name : undefined,
      description: classificationIsAuthoritative ? node.description : undefined,
      logoUrl: classificationIsAuthoritative ? node.logoUrl : undefined,
      publicKey: classificationIsAuthoritative ? incomingKey : undefined,
      softwareVersion: classificationIsAuthoritative ? node.softwareVersion : undefined,
      userCount: classificationIsAuthoritative ? node.userCount : undefined,
      postCount: classificationIsAuthoritative ? node.postCount : undefined,
      mediaCount: classificationIsAuthoritative ? node.mediaCount : undefined,
      isNsfw: incomingIsNsfw,
      nsfwClassificationKnown: incomingClassificationKnown,
      discoveredVia,
      capabilities: classificationIsAuthoritative ? capabilities : null,
      lastSeenAt: new Date(),
      isActive: classificationIsAuthoritative,
      trustScore: classificationIsAuthoritative
        ? SWARM_CONFIG.quarantineTrustScore
        : SWARM_CONFIG.minTrustScore,
    });
    return { isNew: true };
  }

  if (!classificationIsAuthoritative) {
    // Preserve the discovery path for a gossip-only placeholder, but never
    // allow a relay to mutate authoritative node state.
    if (!existing.discoveredVia) {
      await db.update(swarmNodes)
        .set({ discoveredVia, updatedAt: new Date() })
        .where(eq(swarmNodes.domain, normalizedDomain));
    }
    return { isNew: false };
  }

  const existingKeyIsPinned = (existing.discoveredVia === 'direct'
    || existing.discoveredVia === 'announcement'
    || existing.discoveredVia === 'key') && Boolean(existing.publicKey);
  const existingPinnedKey = existingKeyIsPinned
    ? normalizeSwarmNodePublicKey(existing.publicKey)
    : null;
  if (existingKeyIsPinned && (!existingPinnedKey || existingPinnedKey !== incomingKey)) {
    throw new Error(`Node signing key changed for ${normalizedDomain}`);
  }

  // Direct HTTPS contact is authoritative for this node's mutable metadata.
  // Keep local trust/block state and make the adult classification permanent.
  await db.update(swarmNodes)
    .set({
      name: node.name ?? existing.name,
      description: node.description ?? existing.description,
      logoUrl: node.logoUrl ?? existing.logoUrl,
      publicKey: existingKeyIsPinned ? existingPinnedKey : incomingKey,
      softwareVersion: node.softwareVersion ?? existing.softwareVersion,
      userCount: node.userCount ?? existing.userCount,
      postCount: node.postCount ?? existing.postCount,
      mediaCount: node.mediaCount ?? existing.mediaCount,
      isNsfw: incomingClassificationKnown
        ? mergePermanentNodeNsfwClassification(existing.isNsfw, node.isNsfw)
        : existing.isNsfw,
      nsfwClassificationKnown: existing.nsfwClassificationKnown || incomingClassificationKnown,
      discoveredVia,
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
  let safeNodes = filteredNodes.filter(n =>
    isPublicSwarmDomain(n.domain) && getPublicSwarmDomain(n.domain) !== normalizedOurDomain
  );

  const authoritativeBatch = discoveredVia === 'direct' || discoveredVia === 'announcement';
  if (!authoritativeBatch) {
    const [{ count: storedHintCount }] = await db.select({
      count: sql<number>`count(*)`,
    }).from(swarmNodes).where(and(
      eq(swarmNodes.isActive, false),
      eq(swarmNodes.trustScore, SWARM_CONFIG.minTrustScore),
    ));
    const remainingHintSlots = Math.max(
      0,
      SWARM_CONFIG.maxStoredDiscoveryHints - Number(storedHintCount || 0),
    );
    safeNodes = safeNodes.slice(0, Math.min(
      SWARM_CONFIG.maxDiscoveryHintsPerGossip,
      remainingHintSlots,
    ));
  }

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

/** Return the permanent classifier recorded for a peer, active or not. */
export async function getKnownSwarmNodeNsfw(domain: string): Promise<boolean | undefined> {
  if (!db) return undefined;
  const normalizedDomain = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const node = await db.query.swarmNodes.findFirst({ where: { domain: normalizedDomain } });
  if (!node) return undefined;
  if (node.isNsfw) return true;
  return node.nsfwClassificationKnown ? false : undefined;
}

/** Return the pinned key only for directly established, healthy peers. */
export async function getTrustedSwarmReadPeerPublicKey(domain: string): Promise<string | null> {
  if (!db) return null;
  const normalizedDomain = getPublicSwarmDomain(domain);
  if (!normalizedDomain) return null;
  const node = await db.query.swarmNodes.findFirst({ where: { domain: normalizedDomain } });
  const directlyEstablished = node?.discoveredVia === 'direct'
    || node?.discoveredVia === 'announcement';
  if (!(
    node
    && node.isActive
    && !node.isBlocked
    && directlyEstablished
    && node.nsfwClassificationKnown
    && node.publicKey
  )) return null;
  return normalizeSwarmNodePublicKey(node.publicKey);
}

/** Return a directly learned key regardless of reputation, for continuity checks. */
export async function getPinnedSwarmNodePublicKey(domain: string): Promise<string | null> {
  if (!db) return null;
  const normalizedDomain = getPublicSwarmDomain(domain);
  if (!normalizedDomain) return null;
  const node = await db.query.swarmNodes.findFirst({ where: { domain: normalizedDomain } });
  const directlyEstablished = node?.discoveredVia === 'direct'
    || node?.discoveredVia === 'announcement'
    || node?.discoveredVia === 'key';
  return node && directlyEstablished && !node.isBlocked && node.publicKey
    ? normalizeSwarmNodePublicKey(node.publicKey)
    : null;
}

/** Persist the first key fetched from an exact node origin before interactions are accepted. */
export async function pinSwarmNodePublicKey(domain: string, publicKey: string): Promise<void> {
  if (!db) return;
  const normalizedDomain = getPublicSwarmDomain(domain);
  const normalizedKey = normalizeSwarmNodePublicKey(publicKey);
  if (!normalizedDomain || !normalizedKey) throw new Error('Cannot pin an invalid node identity');

  const existing = await db.query.swarmNodes.findFirst({ where: { domain: normalizedDomain } });
  if (existing?.publicKey) {
    const existingKey = normalizeSwarmNodePublicKey(existing.publicKey);
    if (!existingKey || existingKey !== normalizedKey) {
      throw new Error(`Node signing key changed for ${normalizedDomain}`);
    }
    if (existing.publicKey !== existingKey) {
      await db.update(swarmNodes).set({
        publicKey: existingKey,
        updatedAt: new Date(),
      }).where(eq(swarmNodes.domain, normalizedDomain));
    }
    return;
  }

  if (existing) {
    await db.update(swarmNodes).set({
      publicKey: normalizedKey,
      discoveredVia: 'key',
      isActive: false,
      trustScore: SWARM_CONFIG.minTrustScore,
      updatedAt: new Date(),
    }).where(and(
      eq(swarmNodes.domain, normalizedDomain),
      isNull(swarmNodes.publicKey),
    ));
  } else {
    await db.insert(swarmNodes).values({
      domain: normalizedDomain,
      publicKey: normalizedKey,
      discoveredVia: 'key',
      isActive: false,
      trustScore: SWARM_CONFIG.minTrustScore,
      isNsfw: false,
      nsfwClassificationKnown: false,
    }).onConflictDoNothing();
  }

  const pinned = await db.query.swarmNodes.findFirst({ where: { domain: normalizedDomain } });
  if (normalizeSwarmNodePublicKey(pinned?.publicKey) !== normalizedKey) {
    throw new Error(`Node signing key changed for ${normalizedDomain}`);
  }
}

/** Only exact-origin established, healthy peers may make classified reads. */
export async function isTrustedSwarmReadPeer(domain: string): Promise<boolean> {
  return Boolean(await getTrustedSwarmReadPeerPublicKey(domain));
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
    // Never amplify unverified gossip placeholders to additional peers.
    where: { AND: [
      { updatedAt: { gt: since } },
      { isActive: true },
      { isBlocked: false },
      { trustScore: { gt: 20 } },
    ] },
    orderBy: (swarmNodes, { desc }) => [desc(swarmNodes.updatedAt)],
    limit,
  });

  return nodes.filter((node) => isPublicSwarmDomain(node.domain)).map(nodeToInfo);
}

/** Fixed-cost candidates that still require direct origin verification. */
export async function getSwarmDiscoveryCandidates(count: number): Promise<SwarmNodeInfo[]> {
  if (!db) return [];
  const nodes = await db.query.swarmNodes.findMany({
    where: { AND: [
      { isActive: false },
      { isBlocked: false },
      { trustScore: SWARM_CONFIG.minTrustScore },
    ] },
    orderBy: () => sql`RANDOM()`,
    limit: Math.max(0, Math.min(count, SWARM_CONFIG.discoveryProbeFanout)),
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

    const now = new Date();
    const lastTrustIncrease = node.lastSyncAt?.getTime() ?? 0;
    const mayIncreaseTrust = now.getTime() - lastTrustIncrease >= SWARM_CONFIG.gossipIntervalMs;
    const newTrust = Math.min(
      SWARM_CONFIG.maxTrustScore,
      node.trustScore + (mayIncreaseTrust ? SWARM_CONFIG.trustScoreOnSuccess : 0)
    );

    await db.update(swarmNodes)
      .set({
        consecutiveFailures: 0,
        trustScore: newTrust,
        isActive: node.isBlocked ? false : true,
        lastSeenAt: now,
        lastSyncAt: now,
        updatedAt: now,
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
    logoUrl: node.nsfwClassificationKnown && !node.isNsfw
      ? node.logoUrl ?? undefined
      : undefined,
    publicKey: node.publicKey ?? undefined,
    softwareVersion: node.softwareVersion ?? undefined,
    userCount: node.userCount ?? undefined,
    postCount: node.postCount ?? undefined,
    mediaCount: node.mediaCount ?? undefined,
    capabilities: node.capabilities ? JSON.parse(node.capabilities) : undefined,
    isNsfw: node.isNsfw
      ? true
      : node.nsfwClassificationKnown ? false : undefined,
    lastSeenAt: node.lastSeenAt.toISOString(),
    trustScore: node.trustScore,
  };
}
