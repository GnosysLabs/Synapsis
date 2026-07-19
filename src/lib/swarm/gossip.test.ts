import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upsertSwarmNode: vi.fn(),
  upsertSwarmNodes: vi.fn().mockResolvedValue({ added: 0, updated: 0 }),
  upsertRemoteHandleHints: vi.fn().mockResolvedValue({ added: 0, updated: 0, rejected: 0 }),
  pruneExpiredRemoteHandleHints: vi.fn().mockResolvedValue(false),
  getActiveSwarmNodes: vi.fn().mockResolvedValue([]),
  getNodesSince: vi.fn().mockResolvedValue([]),
  getNodesForGossip: vi.fn().mockResolvedValue([]),
  getNodesForPeerExchange: vi.fn().mockResolvedValue([]),
  getSwarmDiscoveryCandidates: vi.fn().mockResolvedValue([]),
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
  discoverNode: vi.fn(),
  signPayload: vi.fn().mockReturnValue('signature'),
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
  getNodesForPeerExchange: mocks.getNodesForPeerExchange,
  getSwarmDiscoveryCandidates: mocks.getSwarmDiscoveryCandidates,
  getActiveSwarmNodes: mocks.getActiveSwarmNodes,
  getNodesSince: mocks.getNodesSince,
  upsertSwarmNode: mocks.upsertSwarmNode,
  upsertSwarmNodes: mocks.upsertSwarmNodes,
  markNodeSuccess: mocks.markNodeSuccess,
  markNodeFailure: mocks.markNodeFailure,
  logSync: mocks.logSync,
}));

vi.mock('@/lib/federation/handles', () => ({
  upsertRemoteHandleHints: mocks.upsertRemoteHandleHints,
  pruneExpiredRemoteHandleHints: mocks.pruneExpiredRemoteHandleHints,
}));

vi.mock('./discovery', () => ({
  buildAnnouncement: mocks.buildAnnouncement,
  discoverNode: mocks.discoverNode,
}));

vi.mock('./safe-federation-http', () => ({
  safeFederationRequest: mocks.safeFederationRequest,
}));

vi.mock('./signature', () => ({
  getNodePrivateKey: vi.fn().mockResolvedValue('PRIVATE KEY'),
  signPayload: mocks.signPayload,
}));

import {
  boundGossipContent,
  establishDirectGossipPeer,
  GOSSIP_MAX_PAYLOAD_BYTES,
  gossipToNode,
  processGossip,
  runGossipRound,
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
    mocks.upsertRemoteHandleHints.mockResolvedValue({ added: 0, updated: 0, rejected: 0 });
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
    expect(mocks.upsertRemoteHandleHints).toHaveBeenCalledWith([], 'peer.social');
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
    expect(mocks.upsertRemoteHandleHints).toHaveBeenCalledWith([], 'peer.social');
  });

  it('re-signs a legacy payload when an older strict peer rejects content clocks', async () => {
    mocks.buildAnnouncement.mockResolvedValueOnce({
      domain: 'local.social',
      name: 'Local',
      publicKey: 'LOCAL KEY',
      softwareVersion: '2',
      userCount: 1,
      postCount: 1,
      mediaCount: 0,
      contentSequence: 42,
      capabilities: ['gossip'],
      isNsfw: true,
      timestamp: '2026-07-18T00:00:00.000Z',
    });
    mocks.safeFederationRequest
      .mockResolvedValueOnce({ status: 400 })
      .mockResolvedValueOnce({
        status: 200,
        json: () => ({
          nodes: [peer],
          handles: [],
          received: { nodes: 0, handles: 0 },
        }),
      });

    await expect(gossipToNode('peer.social')).resolves.toMatchObject({ success: true });

    expect(mocks.safeFederationRequest).toHaveBeenCalledTimes(2);
    const firstOptions = mocks.safeFederationRequest.mock.calls[0]?.[1] as { body: string };
    const secondOptions = mocks.safeFederationRequest.mock.calls[1]?.[1] as { body: string };
    const firstPayload = JSON.parse(firstOptions.body) as SwarmGossipPayload & { signature: string };
    const secondPayload = JSON.parse(secondOptions.body) as SwarmGossipPayload & { signature: string };

    expect(firstPayload.nodes[0]?.contentSequence).toBe(42);
    expect(secondPayload.nodes.every((node) => node.contentSequence === undefined)).toBe(true);
    expect(mocks.signPayload).toHaveBeenNthCalledWith(2, expect.objectContaining({
      nodes: expect.arrayContaining([
        expect.not.objectContaining({ contentSequence: expect.anything() }),
      ]),
    }), 'PRIVATE KEY');
  });

  it('runs bounded handle-hint maintenance even without gossip targets', async () => {
    mocks.getSwarmDiscoveryCandidates.mockResolvedValue([]);
    mocks.getNodesForGossip.mockResolvedValue([]);

    await expect(runGossipRound()).resolves.toMatchObject({ contacted: 0 });

    expect(mocks.pruneExpiredRemoteHandleHints).toHaveBeenCalledOnce();
  });
});

describe('bounded gossip payloads', () => {
  it('keeps self and never emits more than the protocol limit', () => {
    const candidates = Array.from({ length: 125 }, (_, index) => ({
      domain: `peer-${index}.social`,
      publicKey: `KEY ${index}`,
      isNsfw: false,
    }));

    const result = boundGossipContent(
      'local.social',
      { domain: 'local.social', publicKey: 'LOCAL KEY', isNsfw: false },
      candidates,
      [],
      '2026-07-18T00:00:00.000Z',
    );

    expect(result.nodes).toHaveLength(100);
    expect(result.nodes[0]?.domain).toBe('local.social');
  });

  it('deduplicates domains and enforces the serialized byte ceiling', () => {
    const oversizedDescription = 'x'.repeat(48 * 1024);
    const result = boundGossipContent(
      'local.social',
      { domain: 'local.social', publicKey: 'LOCAL KEY', isNsfw: false },
      [
        { domain: 'peer.social', publicKey: 'KEY', isNsfw: false },
        { domain: 'PEER.SOCIAL', publicKey: 'KEY', isNsfw: false },
        ...Array.from({ length: 8 }, (_, index) => ({
          domain: `large-${index}.social`,
          publicKey: `KEY ${index}`,
          isNsfw: false,
          description: oversizedDescription,
        })),
      ],
      [],
      '2026-07-18T00:00:00.000Z',
    );

    expect(result.nodes.filter((node) => node.domain === 'peer.social')).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify({
      sender: 'local.social',
      ...result,
      timestamp: '2026-07-18T00:00:00.000Z',
    }), 'utf8')).toBeLessThanOrEqual(GOSSIP_MAX_PAYLOAD_BYTES);
  });
});
