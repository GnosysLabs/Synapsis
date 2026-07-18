import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upsertSwarmNode: vi.fn(),
  upsertSwarmNodes: vi.fn().mockResolvedValue({ added: 0, updated: 0 }),
  upsertHandleEntries: vi.fn().mockResolvedValue({ added: 0, updated: 0 }),
  getActiveSwarmNodes: vi.fn().mockResolvedValue([]),
  getNodesSince: vi.fn().mockResolvedValue([]),
  getNodesForGossip: vi.fn().mockResolvedValue([]),
  markNodeSuccess: vi.fn(),
  markNodeFailure: vi.fn(),
  logSync: vi.fn(),
  buildAnnouncement: vi.fn().mockResolvedValue({
    domain: 'local.social',
    name: 'Local',
    publicKey: 'LOCAL KEY',
    softwareVersion: '1',
    userCount: 1,
    postCount: 1,
    mediaCount: 0,
    capabilities: ['gossip'],
    isNsfw: true,
    timestamp: '2026-07-18T00:00:00.000Z',
  }),
  safeFederationRequest: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: {
    query: {
      handleRegistry: { findMany: vi.fn().mockResolvedValue([]) },
    },
  },
}));

vi.mock('./registry', () => ({
  getNodesForGossip: mocks.getNodesForGossip,
  getActiveSwarmNodes: mocks.getActiveSwarmNodes,
  getNodesSince: mocks.getNodesSince,
  upsertSwarmNode: mocks.upsertSwarmNode,
  upsertSwarmNodes: mocks.upsertSwarmNodes,
  markNodeSuccess: mocks.markNodeSuccess,
  markNodeFailure: mocks.markNodeFailure,
  logSync: mocks.logSync,
}));

vi.mock('@/lib/federation/handles', () => ({
  upsertHandleEntries: mocks.upsertHandleEntries,
}));

vi.mock('./discovery', () => ({
  buildAnnouncement: mocks.buildAnnouncement,
}));

vi.mock('./safe-federation-http', () => ({
  safeFederationRequest: mocks.safeFederationRequest,
}));

vi.mock('./signature', () => ({
  getNodePrivateKey: vi.fn().mockResolvedValue('PRIVATE KEY'),
  signPayload: vi.fn().mockReturnValue('signature'),
}));

import {
  establishDirectGossipPeer,
  gossipToNode,
  processGossip,
} from './gossip';
import type { SwarmGossipPayload, SwarmNodeInfo } from './types';

const peer: SwarmNodeInfo = {
  domain: 'peer.social',
  name: 'Peer',
  publicKey: 'PEER KEY',
  isNsfw: true,
};

describe('direct peer trust through authenticated gossip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'local.social');
    mocks.upsertSwarmNodes.mockResolvedValue({ added: 0, updated: 0 });
    mocks.upsertHandleEntries.mockResolvedValue({ added: 0, updated: 0 });
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('promotes only a complete self-description for the peer being contacted', async () => {
    await expect(establishDirectGossipPeer([
      { domain: 'relayed.social', publicKey: 'RELAYED KEY', isNsfw: false },
      peer,
    ], 'peer.social')).resolves.toBe(true);

    expect(mocks.upsertSwarmNode).toHaveBeenCalledOnce();
    expect(mocks.upsertSwarmNode).toHaveBeenCalledWith(peer, 'direct');

    await expect(establishDirectGossipPeer([
      { domain: 'peer.social', publicKey: 'PEER KEY' },
    ], 'peer.social')).resolves.toBe(false);
    expect(mocks.upsertSwarmNode).toHaveBeenCalledOnce();
  });

  it('establishes the verified sender while leaving relayed nodes gossip-only', async () => {
    const payload: SwarmGossipPayload = {
      sender: 'peer.social',
      nodes: [peer, { domain: 'relayed.social', publicKey: 'RELAYED KEY', isNsfw: false }],
      handles: [],
      timestamp: '2026-07-18T00:00:00.000Z',
    };

    await processGossip(payload, { senderAuthenticated: true });

    expect(mocks.upsertSwarmNode).toHaveBeenCalledWith(peer, 'direct');
    expect(mocks.upsertSwarmNodes).toHaveBeenCalledWith(payload.nodes, 'peer.social');
  });

  it('establishes the target after a successful direct HTTPS gossip response', async () => {
    mocks.safeFederationRequest.mockResolvedValue({
      status: 200,
      json: () => ({
        nodes: [peer, { domain: 'relayed.social', publicKey: 'RELAYED KEY', isNsfw: false }],
        handles: [],
        received: { nodes: 0, handles: 0 },
      }),
    });

    await expect(gossipToNode('peer.social')).resolves.toMatchObject({ success: true });

    expect(mocks.upsertSwarmNode).toHaveBeenCalledWith(peer, 'direct');
  });
});
