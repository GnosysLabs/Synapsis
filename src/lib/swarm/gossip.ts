/**
 * Swarm Gossip Protocol
 * 
 * Implements epidemic-style gossip for node and handle propagation.
 * Nodes periodically exchange their known nodes/handles with random peers.
 */

import { db, handleRegistry } from '@/db';
import { desc, gt } from 'drizzle-orm';
import type { SwarmGossipPayload, SwarmGossipResponse, SwarmSyncResult, SwarmNodeInfo } from './types';
import { SWARM_CONFIG } from './types';
import {
  getNodesForGossip,
  getActiveSwarmNodes,
  getNodesSince,
  upsertSwarmNodes,
  markNodeSuccess,
  markNodeFailure,
  logSync,
} from './registry';
import { upsertHandleEntries } from '@/lib/federation/handles';
import { buildAnnouncement } from './discovery';

/**
 * Build a gossip payload to send to another node
 */
export async function buildGossipPayload(since?: string): Promise<SwarmGossipPayload> {
  const ourDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:3000';

  // Get nodes to share
  let nodes: SwarmNodeInfo[];
  if (since) {
    nodes = await getNodesSince(new Date(since), SWARM_CONFIG.maxNodesPerGossip);
  } else {
    nodes = await getActiveSwarmNodes(SWARM_CONFIG.maxNodesPerGossip);
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
    isNsfw: announcement.isNsfw,
    capabilities: announcement.capabilities,
    lastSeenAt: new Date().toISOString(),
  };

  // Get handles to share
  let handles: SwarmGossipPayload['handles'] = [];
  if (db) {
    const sinceDate = since ? new Date(since) : undefined;
    const handleEntries = await db.query.handleRegistry.findMany({
      where: sinceDate ? gt(handleRegistry.updatedAt, sinceDate) : undefined,
      orderBy: [desc(handleRegistry.updatedAt)],
      limit: SWARM_CONFIG.maxHandlesPerGossip,
    });

    handles = handleEntries.map(h => ({
      handle: h.handle,
      did: h.did,
      nodeDomain: h.nodeDomain,
      updatedAt: h.updatedAt?.toISOString(),
    }));
  }

  return {
    sender: ourDomain,
    nodes: [selfNode, ...nodes],
    handles,
    timestamp: new Date().toISOString(),
    since,
  };
}

/**
 * Process incoming gossip and return our response
 */
export async function processGossip(
  payload: SwarmGossipPayload
): Promise<SwarmGossipResponse> {
  const startTime = Date.now();

  // Process incoming nodes
  const nodeResult = await upsertSwarmNodes(payload.nodes, payload.sender);

  // Process incoming handles
  let handlesResult = { added: 0, updated: 0 };
  if (payload.handles && payload.handles.length > 0) {
    handlesResult = await upsertHandleEntries(payload.handles);
  }

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

  try {
    const payload = await buildGossipPayload(since);

    // SECURITY: Sign the gossip payload with our private key
    const { signPayload, getNodePrivateKey } = await import('./signature');
    const privateKey = await getNodePrivateKey();
    const signature = signPayload(payload, privateKey);

    const signedPayload = {
      ...payload,
      signature,
    };

    const baseUrl = targetDomain.startsWith('http') ? targetDomain : `https://${targetDomain}`;
    const url = `${baseUrl}/api/swarm/gossip`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(signedPayload),
    });

    const durationMs = Date.now() - startTime;

    if (!response.ok) {
      const error = `HTTP ${response.status}`;
      await markNodeFailure(targetDomain);
      await logSync(targetDomain, 'push', {
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

    const gossipResponse = await response.json() as SwarmGossipResponse;

    // Process the response (nodes and handles they sent back)
    const nodeResult = await upsertSwarmNodes(gossipResponse.nodes, targetDomain);

    let handlesResult = { added: 0, updated: 0 };
    if (gossipResponse.handles && gossipResponse.handles.length > 0) {
      handlesResult = await upsertHandleEntries(gossipResponse.handles);
    }

    await markNodeSuccess(targetDomain);

    const result: SwarmSyncResult = {
      success: true,
      nodesReceived: nodeResult.added + nodeResult.updated,
      nodesSent: payload.nodes.length,
      handlesReceived: handlesResult.added + handlesResult.updated,
      handlesSent: payload.handles?.length || 0,
      durationMs,
    };

    await logSync(targetDomain, 'push', result);
    return result;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';

    await markNodeFailure(targetDomain);

    const result: SwarmSyncResult = {
      success: false,
      nodesReceived: 0,
      nodesSent: 0,
      handlesReceived: 0,
      handlesSent: 0,
      error: errorMsg,
      durationMs,
    };

    await logSync(targetDomain, 'push', result);
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
