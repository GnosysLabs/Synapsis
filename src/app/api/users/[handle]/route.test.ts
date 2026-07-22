import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  fetchSwarmUserProfile: vi.fn(),
  isSwarmNode: vi.fn(),
  fetchNodeInfo: vi.fn(),
  getSession: vi.fn(),
  isLocalNodeNsfw: vi.fn(),
  upsertRemoteUser: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: {
    query: {
      users: {
        findFirst: mocks.findUser,
      },
    },
  },
  users: {},
  follows: {},
}));

vi.mock('@/lib/auth', () => ({
  getSession: mocks.getSession,
}));

vi.mock('@/lib/node/local-node', () => ({
  isLocalNodeNsfw: mocks.isLocalNodeNsfw,
  requireLocalNodeNsfwClassification: mocks.isLocalNodeNsfw,
}));

vi.mock('@/lib/swarm/user-cache', () => ({
  refreshPinnedRemoteUserPresentation: mocks.upsertRemoteUser,
}));

vi.mock('@/lib/swarm/interactions', () => ({
  fetchSwarmUserProfile: mocks.fetchSwarmUserProfile,
  isSwarmNode: mocks.isSwarmNode,
}));

vi.mock('@/lib/swarm/transient-node-probe', () => ({
  probeTransientNode: mocks.fetchNodeInfo,
}));

import { GET } from './route';

const localUser = {
  id: 'user-1',
  handle: 'wpb8erboy@rprh.link',
  username: 'wpb8erboy',
  homeDomain: 'rprh.link',
  isLocalAccount: true,
  displayName: 'Wpb8erboy',
  bio: null,
  avatarUrl: null,
  headerUrl: null,
  followersCount: 1,
  followingCount: 2,
  postsCount: 1,
  createdAt: new Date('2026-07-15T19:32:12Z'),
  website: null,
  movedTo: null,
  publicKey: 'public-key',
  did: 'did:key:local-user',
  dmPrivacy: 'everyone',
  isNsfw: true,
  isSuspended: false,
};

describe('user profile route', () => {
  const previousDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_NODE_DOMAIN = 'rprh.link';
    mocks.findUser.mockReset().mockResolvedValue(localUser);
    mocks.fetchSwarmUserProfile.mockReset();
    mocks.isSwarmNode.mockReset();
    mocks.fetchNodeInfo.mockReset();
    mocks.getSession.mockReset().mockResolvedValue(null);
    mocks.isLocalNodeNsfw.mockReset().mockResolvedValue(false);
    mocks.upsertRemoteUser.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (previousDomain === undefined) {
      delete process.env.NEXT_PUBLIC_NODE_DOMAIN;
    } else {
      process.env.NEXT_PUBLIC_NODE_DOMAIN = previousDomain;
    }
  });

  it('resolves a same-node qualified handle as the local user', async () => {
    const response = await GET(
      new Request('https://rprh.link/api/users/wpb8erboy%40rprh.link'),
      { params: Promise.resolve({ handle: 'wpb8erboy@rprh.link' }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      user: {
        id: 'user-1',
        handle: 'wpb8erboy@rprh.link',
        displayName: 'Wpb8erboy',
        nsfwRestricted: true,
      },
    });
    expect(mocks.findUser).toHaveBeenCalledWith({
      where: {
        AND: [
          { handle: 'wpb8erboy@rprh.link' },
          { isLocalAccount: true },
        ],
      },
    });
    expect(mocks.isSwarmNode).not.toHaveBeenCalled();
    expect(mocks.fetchNodeInfo).not.toHaveBeenCalled();
    expect(mocks.fetchSwarmUserProfile).not.toHaveBeenCalled();
  });

  it('redacts adult-only profile content without replacing its display name', async () => {
    mocks.findUser.mockResolvedValue(null);
    mocks.isSwarmNode.mockResolvedValue(true);
    mocks.fetchSwarmUserProfile.mockResolvedValue({
      profile: {
        handle: 'remoteuser',
        displayName: 'Explicit display name',
        bio: 'Explicit biography',
        avatarUrl: 'https://adult.example/avatar.jpg',
        headerUrl: 'https://adult.example/header.jpg',
        website: 'https://adult.example/profile',
        followersCount: 1,
        followingCount: 2,
        postsCount: 3,
        createdAt: '2026-07-17T00:00:00.000Z',
        isNsfw: false,
        nodeIsNsfw: true,
        nodeDomain: 'adult.example',
      },
      posts: [],
      nodeDomain: 'adult.example',
      timestamp: '2026-07-17T00:00:00.000Z',
    });

    const response = await GET(
      new Request('https://rprh.link/api/users/remoteuser%40adult.example'),
      { params: Promise.resolve({ handle: 'remoteuser@adult.example' }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      user: {
        handle: 'remoteuser@adult.example',
        displayName: 'Explicit display name',
        bio: null,
        avatarUrl: null,
        headerUrl: null,
        website: null,
        nodeIsNsfw: true,
        nsfwRestricted: true,
      },
    });
  });

  it('refreshes the pinned presentation cache after a verified remote profile read', async () => {
    mocks.findUser.mockResolvedValue(null);
    mocks.isSwarmNode.mockResolvedValue(true);
    mocks.fetchSwarmUserProfile.mockResolvedValue({
      profile: {
        handle: 'alice@remote.social',
        displayName: 'Alice Updated',
        avatarUrl: 'https://remote.social/new-avatar.jpg',
        followersCount: 1,
        followingCount: 2,
        postsCount: 3,
        createdAt: '2026-07-17T00:00:00.000Z',
        isNsfw: false,
        nodeIsNsfw: false,
        nodeDomain: 'remote.social',
        did: 'did:key:alice',
        publicKey: 'verified-key',
        stuffboxBadge: null,
      },
      posts: [],
      nodeDomain: 'remote.social',
      timestamp: '2026-07-17T00:00:00.000Z',
    });

    const response = await GET(
      new Request('https://rprh.link/api/users/alice%40remote.social'),
      { params: Promise.resolve({ handle: 'alice@remote.social' }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.upsertRemoteUser).toHaveBeenCalledWith(expect.objectContaining({
      handle: 'alice@remote.social',
      avatarUrl: 'https://remote.social/new-avatar.jpg',
      did: 'did:key:alice',
    }));
  });
});
