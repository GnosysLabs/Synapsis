import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  fetchSwarmUserProfile: vi.fn(),
  isSwarmNode: vi.fn(),
  discoverNode: vi.fn(),
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
  getSession: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/swarm/interactions', () => ({
  fetchSwarmUserProfile: mocks.fetchSwarmUserProfile,
  isSwarmNode: mocks.isSwarmNode,
}));

vi.mock('@/lib/swarm/discovery', () => ({
  discoverNode: mocks.discoverNode,
}));

import { GET } from './route';

const localUser = {
  id: 'user-1',
  handle: 'wpb8erboy',
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
  isBot: false,
  publicKey: 'public-key',
  did: 'did:key:local-user',
  dmPrivacy: 'everyone',
  isNsfw: true,
  isSuspended: false,
  botOwnerId: null,
};

describe('user profile route', () => {
  const previousDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_NODE_DOMAIN = 'rprh.link';
    mocks.findUser.mockReset().mockResolvedValue(localUser);
    mocks.fetchSwarmUserProfile.mockReset();
    mocks.isSwarmNode.mockReset();
    mocks.discoverNode.mockReset();
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
        handle: 'wpb8erboy',
      },
    });
    expect(mocks.findUser).toHaveBeenCalledWith({ where: { handle: 'wpb8erboy' } });
    expect(mocks.isSwarmNode).not.toHaveBeenCalled();
    expect(mocks.discoverNode).not.toHaveBeenCalled();
    expect(mocks.fetchSwarmUserProfile).not.toHaveBeenCalled();
  });
});
