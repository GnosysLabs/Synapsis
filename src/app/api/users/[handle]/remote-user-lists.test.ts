import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchSwarmUserProfile: vi.fn(),
  canAccessSensitiveProfile: vi.fn(),
  getSensitiveContentViewerAccess: vi.fn(),
  signedFederationRead: vi.fn(),
  hydrateSwarmUsers: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: null,
  follows: {},
  users: {},
}));

vi.mock('@/lib/swarm/interactions', () => ({
  fetchSwarmUserProfile: mocks.fetchSwarmUserProfile,
}));

vi.mock('@/lib/nsfw/remote-profile-access', () => ({
  canCurrentViewerAccessSensitiveRemoteProfile: mocks.canAccessSensitiveProfile,
  getCurrentViewerSensitiveProfileAccess: vi.fn(),
  SENSITIVE_PROFILE_MESSAGE: 'Sensitive profile',
  SENSITIVE_REMOTE_PROFILE_MESSAGE: 'Sensitive remote profile',
}));

vi.mock('@/lib/nsfw/viewer-access', () => ({
  getSensitiveContentViewerAccess: mocks.getSensitiveContentViewerAccess,
}));

vi.mock('@/lib/nsfw/content-visibility', () => ({
  redactSensitiveUserSummary: (entry: unknown) => entry,
}));

vi.mock('@/lib/swarm/signed-read', () => ({
  signedFederationRead: mocks.signedFederationRead,
}));

vi.mock('@/lib/swarm/user-hydration', () => ({
  hydrateSwarmUsers: mocks.hydrateSwarmUsers,
}));

import { GET as getFollowers } from './followers/route';
import { GET as getFollowing } from './following/route';

const timestamp = '2026-07-18T12:00:00.000Z';

function remoteResponse(payload: unknown) {
  return {
    status: 200,
    json: () => payload,
  };
}

describe('remote followers and following aggregation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchSwarmUserProfile.mockResolvedValue({
      profile: { isNsfw: false, nodeIsNsfw: false },
    });
    mocks.canAccessSensitiveProfile.mockResolvedValue(true);
    mocks.getSensitiveContentViewerAccess.mockResolvedValue({ canViewSensitive: true });
    mocks.hydrateSwarmUsers.mockImplementation(async (entries) => entries);
  });

  it('hydrates only followers owned by the contacted peer', async () => {
    mocks.signedFederationRead.mockResolvedValue(remoteResponse({
      followers: [
        {
          handle: 'ALICE',
          displayName: 'Alice',
          isRemote: false,
          nodeDomain: 'PEER.SYNAPSIS.SOCIAL',
        },
        {
          handle: 'BOB@BATORBROS.BOND',
          displayName: 'Bob',
          isRemote: true,
          nodeDomain: 'BATORBROS.BOND',
        },
      ],
      nodeDomain: 'PEER.SYNAPSIS.SOCIAL',
      timestamp,
    }));

    const response = await getFollowers(
      new Request('https://synapsis.social/api/users/target%40peer.synapsis.social/followers?limit=10'),
      { params: Promise.resolve({ handle: 'target@peer.synapsis.social' }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.hydrateSwarmUsers).toHaveBeenCalledTimes(1);
    expect(mocks.hydrateSwarmUsers).toHaveBeenCalledWith([
      expect.objectContaining({ handle: 'alice@peer.synapsis.social' }),
    ]);
    expect(mocks.hydrateSwarmUsers).not.toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ handle: 'bob@batorbros.bond' }),
      ]),
    );
    await expect(response.json()).resolves.toMatchObject({
      followers: [
        { handle: 'alice@peer.synapsis.social', nodeDomain: 'peer.synapsis.social' },
        { handle: 'bob@batorbros.bond', nodeDomain: 'batorbros.bond' },
      ],
      nextCursor: null,
    });
  });

  it('hydrates only following accounts owned by the contacted peer', async () => {
    mocks.signedFederationRead.mockResolvedValue(remoteResponse({
      following: [
        {
          handle: 'CAROL',
          displayName: 'Carol',
          isRemote: false,
          nodeDomain: 'PEER.SYNAPSIS.SOCIAL',
        },
        {
          handle: 'DAVE@BATORBROS.BOND',
          displayName: 'Dave',
          isRemote: true,
          nodeDomain: 'BATORBROS.BOND',
        },
      ],
      nodeDomain: 'peer.synapsis.social',
      timestamp,
    }));

    const response = await getFollowing(
      new Request('https://synapsis.social/api/users/target%40peer.synapsis.social/following?limit=10'),
      { params: Promise.resolve({ handle: 'target@peer.synapsis.social' }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.hydrateSwarmUsers).toHaveBeenCalledWith([
      expect.objectContaining({ handle: 'carol@peer.synapsis.social' }),
    ]);
    expect(mocks.hydrateSwarmUsers).not.toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ handle: 'dave@batorbros.bond' }),
      ]),
    );
    await expect(response.json()).resolves.toMatchObject({
      following: [
        { handle: 'carol@peer.synapsis.social', nodeDomain: 'peer.synapsis.social' },
        { handle: 'dave@batorbros.bond', nodeDomain: 'batorbros.bond' },
      ],
      nextCursor: null,
    });
  });

  it('fails closed when a peer returns malformed follower claims', async () => {
    mocks.signedFederationRead.mockResolvedValue(remoteResponse({
      followers: [{
        handle: 'alice@batorbros.bond',
        displayName: 'Alice',
        isRemote: true,
        nodeDomain: 'synapsis.social',
      }],
      nodeDomain: 'peer.synapsis.social',
      timestamp,
    }));

    const response = await getFollowers(
      new Request('https://synapsis.social/api/users/target%40peer.synapsis.social/followers'),
      { params: Promise.resolve({ handle: 'target@peer.synapsis.social' }) },
    );

    await expect(response.json()).resolves.toEqual({ followers: [], nextCursor: null });
    expect(mocks.hydrateSwarmUsers).not.toHaveBeenCalled();
  });
});
