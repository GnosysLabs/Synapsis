/**
 * Swarm Types
 * 
 * Type definitions for the Synapsis swarm network.
 */

export interface SwarmNodeInfo {
  domain: string;
  name?: string;
  description?: string;
  logoUrl?: string;
  publicKey?: string;
  softwareVersion?: string;
  userCount?: number;
  postCount?: number;
  capabilities?: SwarmCapability[];
  isNsfw?: boolean;
  lastSeenAt?: string;
}

export type SwarmCapability = 'handles' | 'gossip' | 'relay' | 'search' | 'interactions' | 'e2ee_dm_v1';

export interface SwarmAnnouncement {
  domain: string;
  name: string;
  description?: string;
  logoUrl?: string;
  publicKey: string;
  softwareVersion: string;
  userCount: number;
  postCount: number;
  capabilities: SwarmCapability[];
  isNsfw: boolean;
  timestamp: string;
  signature?: string; // Signed with node's private key
}

export interface SwarmGossipPayload {
  // The node sending this gossip
  sender: string;
  
  // Nodes this sender knows about
  nodes: SwarmNodeInfo[];
  
  // Optional: handles to sync (piggyback on gossip)
  handles?: {
    handle: string;
    did: string;
    nodeDomain: string;
    updatedAt?: string;
  }[];
  
  // Timestamp for freshness
  timestamp: string;
  
  // Since parameter for incremental sync
  since?: string;
}

export interface SwarmGossipResponse {
  // Nodes we're sharing back
  nodes: SwarmNodeInfo[];
  
  // Handles we're sharing back
  handles?: {
    handle: string;
    did: string;
    nodeDomain: string;
    updatedAt?: string;
  }[];
  
  // Stats about what we received
  received: {
    nodes: number;
    handles: number;
  };
}

export interface SwarmSyncResult {
  success: boolean;
  nodesReceived: number;
  nodesSent: number;
  handlesReceived: number;
  handlesSent: number;
  error?: string;
  durationMs: number;
}

export interface SwarmStats {
  totalNodes: number;
  activeNodes: number;
  totalUsers: number;
  totalPosts: number;
  lastUpdated: string;
}

// Default seed nodes for bootstrapping
export const DEFAULT_SEED_NODES = [
  'synapsis.social',
] as const;

// Swarm configuration
export const SWARM_CONFIG = {
  // How often to run gossip (in ms)
  gossipIntervalMs: 5 * 60 * 1000, // 5 minutes
  
  // How many nodes to gossip with per round
  gossipFanout: 3,
  
  // Max nodes to include in a single gossip message
  maxNodesPerGossip: 100,
  
  // Max handles to include in a single gossip message
  maxHandlesPerGossip: 500,
  
  // How long before a node is considered inactive
  inactiveThresholdMs: 24 * 60 * 60 * 1000, // 24 hours
  
  // How many consecutive failures before marking inactive
  maxConsecutiveFailures: 5,
  
  // Trust score adjustments
  trustScoreOnSuccess: 1,
  trustScoreOnFailure: -5,
  minTrustScore: 0,
  maxTrustScore: 100,
  defaultTrustScore: 50,
} as const;
