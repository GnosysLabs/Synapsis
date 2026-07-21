/**
 * Swarm Registry
 * 
 * Manages the local registry of known swarm nodes.
 */

import { db, media, posts, remotePosts, swarmContentSyncStates, swarmNodes, swarmSeeds, swarmSyncLog, users } from '@/db';
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
      contentSequence: classificationIsAuthoritative ? node.contentSequence : undefined,
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
    if (classificationIsAuthoritative) {
      await db.insert(swarmContentSyncStates).values({
        domain: normalizedDomain,
        nextAttemptAt: new Date(),
      }).onConflictDoNothing();
    }
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
      contentSequence: node.contentSequence ?? existing.contentSequence,
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

  // Adult classification is permanent and must affect already-cached rows
  // immediately. Waiting for individual post changes could otherwise expose a
  // node converted to NSFW through stale pre-conversion cache metadata.
  if (incomingIsNsfw && !existing.isNsfw) {
    await db.update(remotePosts).set({
      nodeIsNsfw: true,
      fetchedAt: new Date(),
    }).where(eq(remotePosts.nodeDomain, normalizedDomain));
  }

  // A post-count change is a cheap, exact-origin activity hint. It only
  // prioritizes that same peer, so a malicious node cannot make us fan out to
  // third parties or crowd quiet peers out of the fair background sweep.
  const exactOriginContentChanged = typeof node.contentSequence === 'number'
    ? existing.contentSequence === null || node.contentSequence !== existing.contentSequence
    : typeof node.postCount === 'number'
      && (existing.postCount === null || node.postCount !== existing.postCount);
  if (exactOriginContentChanged) {
    const now = new Date();
    await db.insert(swarmContentSyncStates).values({
      domain: normalizedDomain,
      nextAttemptAt: now,
    }).onConflictDoNothing();
    await db.update(swarmContentSyncStates).set({
      nextAttemptAt: now,
      updatedAt: now,
    }).where(eq(swarmContentSyncStates.domain, normalizedDomain));
  }

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
    // Exact-origin contact establishes identity, not good behavior. Keep a
    // newly contacted node out of feeds and public discovery until at least
    // one later successful exchange advances it beyond quarantine.
    where: { AND: [
      { isActive: true },
      { isBlocked: false },
      { remoteAccessDeniedAt: { isNull: true } },
      { trustScore: { gt: SWARM_CONFIG.quarantineTrustScore } },
    ] },
    orderBy: (swarmNodes, { desc }) => [desc(swarmNodes.lastSeenAt)],
    ...(limit === undefined ? {} : { limit }),
  });

  return nodes.filter((node) => isPublicSwarmDomain(node.domain)).map(nodeToInfo);
}

/** Point lookup used by request paths; never scan an arbitrary peer prefix. */
export async function getActiveSwarmNode(domain: string): Promise<SwarmNodeInfo | null> {
  if (!db) return null;
  const normalizedDomain = getPublicSwarmDomain(domain);
  if (!normalizedDomain) return null;

  const node = await db.query.swarmNodes.findFirst({
    where: { AND: [
      { domain: normalizedDomain },
      { isActive: true },
      { isBlocked: false },
      { remoteAccessDeniedAt: { isNull: true } },
      { trustScore: { gt: SWARM_CONFIG.quarantineTrustScore } },
    ] },
  });
  return node && isPublicSwarmDomain(node.domain) ? nodeToInfo(node) : null;
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

/**
 * Authenticate a directly established peer for bounded read-only federation.
 *
 * Availability reputation controls whether we ingest that peer's content; it
 * must not control whether the peer can prove its identity to read our public
 * timeline. Coupling those concerns creates a recovery deadlock after an
 * outage: the peer cannot make the successful request needed to regain trust.
 */
export async function getTrustedSwarmReadPeerPublicKey(domain: string): Promise<string | null> {
  if (!db) return null;
  const normalizedDomain = getPublicSwarmDomain(domain);
  if (!normalizedDomain) return null;
  const node = await db.query.swarmNodes.findFirst({ where: { domain: normalizedDomain } });
  const directlyEstablished = node?.discoveredVia === 'direct'
    || node?.discoveredVia === 'announcement';
  if (!(
    node
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

  // Get active, post-quarantine nodes ordered randomly.
  const nodes = await db.query.swarmNodes.findMany({
    where: { AND: [
      { isActive: true },
      { isBlocked: false },
      { remoteAccessDeniedAt: { isNull: true } },
      { trustScore: { gt: SWARM_CONFIG.quarantineTrustScore } },
    ] },
    orderBy: () => sql`RANDOM()`,
    limit: Math.max(0, Math.min(count, SWARM_CONFIG.gossipFanout)),
  });

  return nodes.filter((node) => isPublicSwarmDomain(node.domain)).map(nodeToInfo);
}

/** Select a tiny established relay set without revisiting this cursor's peers. */
export async function getNodesForChangeNotice(
  count: number,
  excludedDomains: readonly string[] = [],
): Promise<SwarmNodeInfo[]> {
  if (!db) return [];
  const boundedCount = Math.max(0, Math.min(count, 3));
  if (boundedCount === 0) return [];
  const excluded = new Set(excludedDomains
    .map(getPublicSwarmDomain)
    .filter((domain): domain is string => Boolean(domain)));
  const candidates = await db.query.swarmNodes.findMany({
    where: { AND: [
      { isActive: true },
      { isBlocked: false },
      { remoteAccessDeniedAt: { isNull: true } },
      { trustScore: { gt: SWARM_CONFIG.quarantineTrustScore } },
      { nsfwClassificationKnown: true },
      { publicKey: { isNotNull: true } },
      { OR: [
        { discoveredVia: 'direct' },
        { discoveredVia: 'announcement' },
      ] },
    ] },
    orderBy: () => sql`RANDOM()`,
    limit: Math.min(64, boundedCount + excluded.size + 8),
  });
  return candidates
    .filter((node) => isPublicSwarmDomain(node.domain) && !excluded.has(node.domain))
    .slice(0, boundedCount)
    .map(nodeToInfo);
}

/**
 * Rotate origin-verified identities through gossip so a large registry does
 * not permanently expose only its newest prefix. These entries are relayed as
 * hints and still require exact-origin verification by the receiver.
 */
export async function getNodesForPeerExchange(count: number): Promise<SwarmNodeInfo[]> {
  if (!db) return [];
  const boundedCount = Math.max(0, Math.min(count, SWARM_CONFIG.maxNodesPerGossip - 1));
  if (boundedCount === 0) return [];

  const nodes = await db.query.swarmNodes.findMany({
    where: { AND: [
      { isBlocked: false },
      { remoteAccessDeniedAt: { isNull: true } },
      { OR: [
        { discoveredVia: 'direct' },
        { discoveredVia: 'announcement' },
      ] },
    ] },
    orderBy: () => sql`RANDOM()`,
    limit: boundedCount,
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
      { remoteAccessDeniedAt: { isNull: true } },
      { trustScore: { gt: SWARM_CONFIG.quarantineTrustScore } },
    ] },
    orderBy: (swarmNodes, { desc }) => [desc(swarmNodes.updatedAt)],
    limit,
  });

  return nodes.filter((node) => isPublicSwarmDomain(node.domain)).map(nodeToInfo);
}

/**
 * Fixed-cost candidates that still require direct origin verification.
 *
 * Retry previously established peers before probing gossip-only hints. An
 * established peer can retain a positive trust score after enough failures to
 * become inactive; restricting retries to zero-trust hints would strand that
 * peer permanently. Direct discovery still verifies the peer at its own HTTPS
 * origin and enforces its pinned signing key before reactivation.
 */
export async function getSwarmDiscoveryCandidates(count: number): Promise<SwarmNodeInfo[]> {
  if (!db) return [];
  const limit = Math.max(0, Math.min(count, SWARM_CONFIG.discoveryProbeFanout));
  if (limit === 0) return [];

  const establishedNodes = await db.query.swarmNodes.findMany({
    where: { AND: [
      { isActive: false },
      { isBlocked: false },
      { OR: [
        { discoveredVia: 'direct' },
        { discoveredVia: 'announcement' },
      ] },
    ] },
    orderBy: (swarmNodes, { desc }) => [desc(swarmNodes.lastSeenAt)],
    limit,
  });

  const candidates = establishedNodes.filter((node) => isPublicSwarmDomain(node.domain));
  const remaining = limit - candidates.length;
  if (remaining <= 0) return candidates.slice(0, limit).map(nodeToInfo);

  const gossipHints = await db.query.swarmNodes.findMany({
    where: { AND: [
      { isActive: false },
      { isBlocked: false },
      { trustScore: SWARM_CONFIG.minTrustScore },
    ] },
    orderBy: () => sql`RANDOM()`,
    limit: remaining,
  });
  const establishedDomains = new Set(candidates.map((node) => node.domain));
  return [
    ...candidates,
    ...gossipHints.filter((node) => (
      isPublicSwarmDomain(node.domain) && !establishedDomains.has(node.domain)
    )),
  ].slice(0, limit).map(nodeToInfo);
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
export async function markNodeSuccess(
  domain: string,
  options: { verifiedContent?: boolean } = {},
): Promise<void> {
  if (!db) return;

  try {
    const node = await db.query.swarmNodes.findFirst({
      where: { domain: domain },
    });

    if (!node) return;

    const now = new Date();
    const lastTrustIncrease = node.lastSyncAt?.getTime() ?? 0;
    const recoversAvailabilityQuarantine = options.verifiedContent === true
      && node.trustScore <= SWARM_CONFIG.quarantineTrustScore;
    const mayIncreaseTrust = recoversAvailabilityQuarantine
      || now.getTime() - lastTrustIncrease >= SWARM_CONFIG.gossipIntervalMs;
    const trustBaseline = recoversAvailabilityQuarantine
      ? SWARM_CONFIG.quarantineTrustScore
      : node.trustScore;
    const newTrust = Math.min(
      SWARM_CONFIG.maxTrustScore,
      trustBaseline + (mayIncreaseTrust ? SWARM_CONFIG.trustScoreOnSuccess : 0)
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
  const configuredSeeds = (process.env.SYNAPSIS_SEED_NODES || '')
    .split(',')
    .map((domain) => getCanonicalSwarmSeedDomain(domain))
    .filter((domain): domain is string => domain !== null);
  const fallbackSeeds = Array.from(new Set([
    ...configuredSeeds,
    ...DEFAULT_SEED_NODES.filter(isPublicSwarmDomain),
  ]));
  if (!db) {
    return fallbackSeeds;
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

  return Array.from(new Set([...publicSeeds, ...fallbackSeeds]));
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

  const [networkRows, localUsers, localPosts, localMedia] = await Promise.all([
    db.select({
      totalNodes: sql<number>`count(*)`,
      activeNodes: sql<number>`coalesce(sum(case when ${swarmNodes.isActive} = 1 and ${swarmNodes.isBlocked} = 0 and ${swarmNodes.remoteAccessDeniedAt} is null and ${swarmNodes.trustScore} > ${SWARM_CONFIG.quarantineTrustScore} then 1 else 0 end), 0)`,
      totalUsers: sql<number>`coalesce(sum(case when ${swarmNodes.isActive} = 1 and ${swarmNodes.isBlocked} = 0 and ${swarmNodes.remoteAccessDeniedAt} is null and ${swarmNodes.trustScore} > ${SWARM_CONFIG.quarantineTrustScore} then coalesce(${swarmNodes.userCount}, 0) else 0 end), 0)`,
      totalPosts: sql<number>`coalesce(sum(case when ${swarmNodes.isActive} = 1 and ${swarmNodes.isBlocked} = 0 and ${swarmNodes.remoteAccessDeniedAt} is null and ${swarmNodes.trustScore} > ${SWARM_CONFIG.quarantineTrustScore} then coalesce(${swarmNodes.postCount}, 0) else 0 end), 0)`,
      totalMedia: sql<number>`coalesce(sum(case when ${swarmNodes.isActive} = 1 and ${swarmNodes.isBlocked} = 0 and ${swarmNodes.remoteAccessDeniedAt} is null and ${swarmNodes.trustScore} > ${SWARM_CONFIG.quarantineTrustScore} then coalesce(${swarmNodes.mediaCount}, 0) else 0 end), 0)`,
    }).from(swarmNodes),
    db.select({ count: sql<number>`count(*)` }).from(users)
      .where(eq(users.isLocalAccount, true)),
    db.select({ count: sql<number>`count(*)` }).from(posts),
    db.select({ count: sql<number>`count(*)` }).from(media).where(isNotNull(media.postId)),
  ]);

  const hasPublicLocalNode = isPublicSwarmDomain(process.env.NEXT_PUBLIC_NODE_DOMAIN);
  const network = networkRows[0];
  return {
    totalNodes: Number(network?.totalNodes ?? 0) + (hasPublicLocalNode ? 1 : 0),
    activeNodes: Number(network?.activeNodes ?? 0),
    totalUsers: Number(network?.totalUsers ?? 0) + (hasPublicLocalNode ? Number(localUsers[0]?.count ?? 0) : 0),
    totalPosts: Number(network?.totalPosts ?? 0) + (hasPublicLocalNode ? Number(localPosts[0]?.count ?? 0) : 0),
    totalMedia: Number(network?.totalMedia ?? 0) + (hasPublicLocalNode ? Number(localMedia[0]?.count ?? 0) : 0),
  };
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
    contentSequence: node.contentSequence ?? undefined,
    capabilities: node.capabilities ? JSON.parse(node.capabilities) : undefined,
    isNsfw: node.isNsfw
      ? true
      : node.nsfwClassificationKnown ? false : undefined,
    lastSeenAt: node.lastSeenAt.toISOString(),
    trustScore: node.trustScore,
  };
}
