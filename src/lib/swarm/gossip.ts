/**
 * Swarm Gossip Protocol
 * 
 * Implements epidemic-style gossip for node and handle propagation.
 * Nodes periodically exchange their known nodes/handles with random peers.
 */

import { db } from '@/db';
import type { SwarmGossipPayload, SwarmGossipResponse, SwarmSyncResult, SwarmNodeInfo } from './types';
import { SWARM_CONFIG } from './types';
import {
  getNodesForGossip,
  getNodesSince,
  getNodesForPeerExchange,
  getSwarmDiscoveryCandidates,
  upsertSwarmNode,
  upsertSwarmNodes,
  markNodeSuccess,
  markNodeFailure,
  logSync,
} from './registry';
import {
  pruneExpiredRemoteHandleHints,
  upsertRemoteHandleHints,
} from '@/lib/federation/handles';
import { buildAnnouncement, discoverNode } from './discovery';
import { requireCanonicalAccountHomeDomain } from '@/lib/identity/account-address';
import { getPublicSwarmDomain, isPublicSwarmDomain } from './node-domain';
import { safeFederationRequest } from './safe-federation-http';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { swarmNodeInfoSchema } from './node-payload';

const gossipHandleSchema = z.object({
  handle: z.string().min(3).max(640),
  did: z.string().min(1).max(1_024),
  nodeDomain: z.string().min(1).max(253),
  updatedAt: z.string().datetime().optional(),
});

const gossipResponseSchema = z.object({
  nodes: z.array(swarmNodeInfoSchema).max(SWARM_CONFIG.maxNodesPerGossip),
  handles: z.array(gossipHandleSchema).max(SWARM_CONFIG.maxHandlesPerGossip).optional(),
  received: z.object({
    nodes: z.number().int().nonnegative().max(SWARM_CONFIG.maxNodesPerGossip),
    handles: z.number().int().nonnegative().max(SWARM_CONFIG.maxHandlesPerGossip),
  }),
});

export const GOSSIP_MAX_PAYLOAD_BYTES = 192 * 1024;

type GossipHandle = NonNullable<SwarmGossipPayload['handles']>[number];

function legacyGossipPayload(payload: SwarmGossipPayload): SwarmGossipPayload {
  return {
    ...payload,
    nodes: payload.nodes.map((node) => {
      const legacyNode = { ...node };
      delete legacyNode.contentSequence;
      return legacyNode;
    }),
  };
}

/** Reserve the first node slot for self, deduplicate peers, and cap bytes. */
export function boundGossipContent(
  sender: string,
  selfNode: SwarmNodeInfo | null,
  candidateNodes: SwarmNodeInfo[],
  candidateHandles: GossipHandle[],
  timestamp: string,
  since?: string,
): Pick<SwarmGossipPayload, 'nodes' | 'handles'> {
  const nodes: SwarmNodeInfo[] = [];
  const handles: GossipHandle[] = [];
  const seenDomains = new Set<string>();
  const fits = (nextNodes: SwarmNodeInfo[], nextHandles: GossipHandle[]) => (
    Buffer.byteLength(JSON.stringify({
      sender,
      nodes: nextNodes,
      handles: nextHandles,
      timestamp,
      since,
    }), 'utf8') <= GOSSIP_MAX_PAYLOAD_BYTES
  );

  for (const node of [selfNode, ...candidateNodes]) {
    if (!node) continue;
    const domain = getPublicSwarmDomain(node.domain);
    if (!domain || seenDomains.has(domain) || nodes.length >= SWARM_CONFIG.maxNodesPerGossip) continue;
    const publicNode = { ...node, domain };
    delete publicNode.trustScore;
    if (!fits([...nodes, publicNode], handles)) break;
    nodes.push(publicNode);
    seenDomains.add(domain);
  }

  for (const handle of candidateHandles.slice(0, SWARM_CONFIG.maxHandlesPerGossip)) {
    if (!fits(nodes, [...handles, handle])) break;
    handles.push(handle);
  }

  return { nodes, handles };
}

/**
 * A successful gossip exchange is a direct peer handshake: incoming gossip is
 * signature-verified by the route, while an outgoing response is received from
 * the peer's own HTTPS origin. Promote only that peer's self-description. Nodes
 * merely relayed inside the same gossip payload remain gossip-only.
 */
export async function establishDirectGossipPeer(
  nodes: SwarmNodeInfo[],
  peerDomain: string,
): Promise<boolean> {
  const normalizedPeer = getPublicSwarmDomain(peerDomain);
  if (!normalizedPeer) return false;

  const peer = nodes.find((node) =>
    getPublicSwarmDomain(node.domain) === normalizedPeer
    && typeof node.isNsfw === 'boolean'
    && typeof node.publicKey === 'string'
    && node.publicKey.trim().length > 0
  );
  if (!peer) return false;

  await upsertSwarmNode({ ...peer, domain: normalizedPeer }, 'direct');
  return true;
}

/**
 * Build a gossip payload to send to another node
 */
export async function buildGossipPayload(since?: string): Promise<SwarmGossipPayload> {
  const ourDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';
  const ourAccountDomain = requireCanonicalAccountHomeDomain(ourDomain);

  // Get nodes to share
  let nodes: SwarmNodeInfo[];
  if (since) {
    nodes = await getNodesSince(new Date(since), SWARM_CONFIG.maxNodesPerGossip - 1);
  } else {
    nodes = await getNodesForPeerExchange(SWARM_CONFIG.maxNodesPerGossip - 1);
  }

  // Include ourselves in the node list
  const announcement = await buildAnnouncement();
  const selfNode: SwarmNodeInfo = {
    domain: announcement.domain,
    name: announcement.name,
    description: announcement.description,
    logoUrl: announcement.logoUrl,
    publicKey: announcement.publicKey,
    softwareVersion: announcement.softwareVersion,
    userCount: announcement.userCount,
    postCount: announcement.postCount,
    mediaCount: announcement.mediaCount,
    contentSequence: announcement.contentSequence,
    isNsfw: announcement.isNsfw,
    capabilities: announcement.capabilities,
    lastSeenAt: new Date().toISOString(),
  };

  // Get handles to share
  let handles: SwarmGossipPayload['handles'] = [];
  if (db) {
    const sinceDate = since ? new Date(since) : undefined;
    const handleEntries = await db.query.handleRegistry.findMany({
      where: {
        AND: [
          { nodeDomain: ourAccountDomain },
          { identityVerified: true },
          { deletedAt: { isNull: true } },
          ...(sinceDate ? [{ updatedAt: { gt: sinceDate } }] : []),
        ],
      },
      // Delta requests need deterministic newest-first ordering. Ordinary
      // gossip rotates a random sample so accounts older than the first page
      // remain discoverable when a node has thousands of users.
      orderBy: sinceDate
        ? (handleRegistry, { desc }) => [desc(handleRegistry.updatedAt)]
        : () => sql`RANDOM()`,
      limit: SWARM_CONFIG.maxHandlesPerGossip,
    });

    handles = handleEntries.map(h => ({
      handle: h.handle,
      did: h.did,
      nodeDomain: h.nodeDomain,
      updatedAt: h.updatedAt?.toISOString(),
    }));
  }

  const timestamp = new Date().toISOString();
  const bounded = boundGossipContent(
    ourDomain,
    isPublicSwarmDomain(ourDomain) ? selfNode : null,
    nodes,
    handles.filter((handle) => isPublicSwarmDomain(handle.nodeDomain)),
    timestamp,
    since,
  );

  return {
    sender: ourDomain,
    nodes: bounded.nodes,
    handles: bounded.handles,
    timestamp,
    since,
  };
}

/**
 * Process incoming gossip and return our response
 */
export async function processGossip(
  payload: SwarmGossipPayload,
  options: { senderAuthenticated: boolean },
): Promise<SwarmGossipResponse> {
  if (options.senderAuthenticated) {
    await establishDirectGossipPeer(payload.nodes, payload.sender);
  }

  // Process incoming nodes
  const nodeResult = await upsertSwarmNodes(payload.nodes, payload.sender);

  // Process incoming handles
  const publicHandles = payload.handles?.filter((handle) => isPublicSwarmDomain(handle.nodeDomain)) ?? [];
  const handlesResult = await upsertRemoteHandleHints(publicHandles, payload.sender);

  // Build our response with nodes/handles to share back
  const responsePayload = await buildGossipPayload(payload.since);

  return {
    nodes: responsePayload.nodes,
    handles: responsePayload.handles,
    received: {
      nodes: nodeResult.added + nodeResult.updated,
      handles: handlesResult.added + handlesResult.updated,
    },
  };
}

/**
 * Send gossip to a specific node
 * 
 * SECURITY: Signs the gossip payload with the node's private key
 */
export async function gossipToNode(
  targetDomain: string,
  since?: string
): Promise<SwarmSyncResult> {
  const startTime = Date.now();
  const publicTargetDomain = getPublicSwarmDomain(targetDomain);

  if (!isPublicSwarmDomain(process.env.NEXT_PUBLIC_NODE_DOMAIN) || !publicTargetDomain) {
    return {
      success: false,
      nodesReceived: 0,
      nodesSent: 0,
      handlesReceived: 0,
      handlesSent: 0,
      error: 'Public swarm participation requires real ICANN domains',
      durationMs: Date.now() - startTime,
    };
  }

  try {
    const payload = await buildGossipPayload(since);

    // SECURITY: Sign the gossip payload with our private key
    const { signPayload, getNodePrivateKey } = await import('./signature');
    const privateKey = await getNodePrivateKey();
    const signature = signPayload(payload, privateKey);

    const baseUrl = `https://${publicTargetDomain}`;
    const url = `${baseUrl}/api/swarm/gossip`;

    const sendGossip = (outgoing: SwarmGossipPayload, outgoingSignature: string) => (
      safeFederationRequest(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ ...outgoing, signature: outgoingSignature }),
        timeoutMs: 8_000,
        maxResponseBytes: 256 * 1024,
      })
    );

    let response = await sendGossip(payload, signature);
    if (response.status === 400 && payload.nodes.some((node) => node.contentSequence !== undefined)) {
      // Older strict receivers reject the new content clock as an unknown
      // field. A freshly signed legacy retry keeps gossip alive while nodes are
      // upgraded, without hiding overload, auth, or transport failures.
      const legacyPayload = legacyGossipPayload(payload);
      response = await sendGossip(
        legacyPayload,
        signPayload(legacyPayload, privateKey),
      );
    }

    const durationMs = Date.now() - startTime;

    if (response.status < 200 || response.status >= 300) {
      const error = `HTTP ${response.status}`;
      await markNodeFailure(publicTargetDomain);
      await logSync(publicTargetDomain, 'push', {
        success: false,
        nodesReceived: 0,
        nodesSent: payload.nodes.length,
        handlesReceived: 0,
        handlesSent: payload.handles?.length || 0,
        error,
        durationMs,
      });
      return {
        success: false,
        nodesReceived: 0,
        nodesSent: payload.nodes.length,
        handlesReceived: 0,
        handlesSent: payload.handles?.length || 0,
        error,
        durationMs,
      };
    }

    const gossipResponse = gossipResponseSchema.parse(response.json()) as SwarmGossipResponse;

    // The response came from the exact HTTPS origin we contacted, so its own
    // complete self-description establishes the target as a direct peer.
    if (!await establishDirectGossipPeer(gossipResponse.nodes, publicTargetDomain)) {
      throw new Error('Gossip peer did not provide a complete exact-origin identity');
    }

    // Process the response (nodes and handles they sent back)
    const nodeResult = await upsertSwarmNodes(gossipResponse.nodes, publicTargetDomain);

    const publicHandles = gossipResponse.handles?.filter((handle) => isPublicSwarmDomain(handle.nodeDomain)) ?? [];
    const handlesResult = await upsertRemoteHandleHints(publicHandles, publicTargetDomain);

    await markNodeSuccess(publicTargetDomain);

    const result: SwarmSyncResult = {
      success: true,
      nodesReceived: nodeResult.added + nodeResult.updated,
      nodesSent: payload.nodes.length,
      handlesReceived: handlesResult.added + handlesResult.updated,
      handlesSent: payload.handles?.length || 0,
      durationMs,
    };

    await logSync(publicTargetDomain, 'push', result);
    return result;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';

    await markNodeFailure(publicTargetDomain);

    const result: SwarmSyncResult = {
      success: false,
      nodesReceived: 0,
      nodesSent: 0,
      handlesReceived: 0,
      handlesSent: 0,
      error: errorMsg,
      durationMs,
    };

    await logSync(publicTargetDomain, 'push', result);
    return result;
  }
}

/**
 * Run a gossip round - contact random nodes and exchange info
 */
export async function runGossipRound(): Promise<{
  contacted: number;
  successful: number;
  totalNodesReceived: number;
  totalHandlesReceived: number;
}> {
  // Maintenance is periodic and bounded even when every peer returns an empty
  // handle set or there are currently no gossip targets.
  await pruneExpiredRemoteHandleHints();
  if (!isPublicSwarmDomain(process.env.NEXT_PUBLIC_NODE_DOMAIN)) {
    return { contacted: 0, successful: 0, totalNodesReceived: 0, totalHandlesReceived: 0 };
  }

  // Gossip is a hint, not authority. Probe only a fixed number of candidates
  // directly before they can become active participants.
  const discoveryCandidates = await getSwarmDiscoveryCandidates(SWARM_CONFIG.discoveryProbeFanout);
  for (const candidate of discoveryCandidates) {
    await discoverNode(candidate.domain);
  }

  // Get random nodes to gossip with
  const targets = await getNodesForGossip(SWARM_CONFIG.gossipFanout);

  let contacted = 0;
  let successful = 0;
  let totalNodesReceived = 0;
  let totalHandlesReceived = 0;

  for (const target of targets) {
    contacted++;
    const result = await gossipToNode(target.domain);

    if (result.success) {
      successful++;
      totalNodesReceived += result.nodesReceived;
      totalHandlesReceived += result.handlesReceived;
    }
  }

  return {
    contacted,
    successful,
    totalNodesReceived,
    totalHandlesReceived,
  };
}
