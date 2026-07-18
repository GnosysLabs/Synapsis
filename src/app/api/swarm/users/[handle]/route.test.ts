import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trustedRead: vi.fn(),
  localNodeIsNsfw: vi.fn(),
  findUser: vi.fn(),
  findPosts: vi.fn(),
}));

vi.mock('@/lib/swarm/signed-read', () => ({
  isTrustedFederationRead: mocks.trustedRead,
}));

vi.mock('@/lib/node/local-node', () => ({
  requireLocalNodeNsfwClassification: mocks.localNodeIsNsfw,
}));

vi.mock('@/db', () => ({
  db: {
    query: {
      users: { findFirst: mocks.findUser },
      posts: { findMany: mocks.findPosts },
      remoteReposts: { findMany: vi.fn().mockResolvedValue([]) },
      userSwarmReposts: { findMany: vi.fn().mockResolvedValue([]) },
      swarmAccountTombstones: { findFirst: vi.fn().mockResolvedValue(undefined) },
    },
  },
  media: {},
  posts: {},
  users: {},
  userSwarmReposts: {},
  swarmAccountTombstones: {},
}));

import { GET } from './route';

const adultUser = {
  id: 'adult-user',
  handle: 'adult',
  nodeId: null,
  displayName: 'PRIVATE DISPLAY NAME',
  bio: 'PRIVATE BIO',
  avatarUrl: 'https://adult.example/private-avatar.jpg',
  headerUrl: 'https://adult.example/private-header.jpg',
  website: 'https://adult.example/private-profile',
  followersCount: 1,
  followingCount: 2,
  postsCount: 1,
  createdAt: new Date('2026-07-17T00:00:00.000Z'),
  publicKey: 'public-key',
  did: 'did:key:adult',
  isNsfw: true,
  isSuspended: false,
};

const adultPost = {
  id: 'post-1',
  userId: adultUser.id,
  content: 'PRIVATE FEDERATION BODY',
  createdAt: new Date('2026-07-17T00:00:00.000Z'),
  isNsfw: true,
  likesCount: 0,
  repostsCount: 0,
  repliesCount: 0,
  linkPreviewUrl: 'https://adult.example/private-story',
  linkPreviewTitle: 'PRIVATE TITLE',
  linkPreviewDescription: 'PRIVATE DESCRIPTION',
  linkPreviewImage: 'https://adult.example/private-preview.jpg',
  linkPreviewType: 'card',
  linkPreviewVideoUrl: null,
  linkPreviewMediaJson: null,
  repostOfId: null,
  author: adultUser,
  media: [{
    url: 'https://adult.example/private-video.mp4',
    mimeType: 'video/mp4',
    altText: null,
  }],
  repostOf: null,
};

describe('GET /api/swarm/users/[handle] read authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'adult.example');
    mocks.localNodeIsNsfw.mockResolvedValue(true);
    mocks.trustedRead.mockResolvedValue(false);
    mocks.findUser.mockResolvedValue(adultUser);
    mocks.findPosts.mockResolvedValue([adultPost]);
  });

  it('returns only a profile stub and no posts to an unsigned caller', async () => {
    const response = await GET(
      new Request('https://adult.example/api/swarm/users/adult') as never,
      { params: Promise.resolve({ handle: 'adult' }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      profile: {
        handle: 'adult',
        displayName: 'adult',
        nsfwRestricted: true,
      },
      posts: [],
    });
    const serialized = JSON.stringify(body);
    for (const secret of [
      'PRIVATE',
      'private-avatar.jpg',
      'private-header.jpg',
      'private-video.mp4',
      'private-preview.jpg',
      'private-story',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('returns full data only to a trusted signed peer', async () => {
    mocks.trustedRead.mockResolvedValue(true);
    const response = await GET(
      new Request('https://adult.example/api/swarm/users/adult') as never,
      { params: Promise.resolve({ handle: 'adult' }) },
    );
    const body = await response.json();

    expect(body.profile.avatarUrl).toContain('private-avatar.jpg');
    expect(body.posts[0].content).toBe('PRIVATE FEDERATION BODY');
    expect(body.posts[0].media[0].url).toContain('private-video.mp4');
  });

  it('rejects qualified cached-remote handles instead of laundering them as local', async () => {
    const response = await GET(
      new Request('https://adult.example/api/swarm/users/user%40remote.example') as never,
      { params: Promise.resolve({ handle: 'user@remote.example' }) },
    );

    expect(response.status).toBe(404);
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it('rejects a user row linked to a remote node even when its handle is unqualified', async () => {
    mocks.findUser.mockResolvedValue({
      ...adultUser,
      nodeId: 'remote-node-id',
    });

    const response = await GET(
      new Request('https://adult.example/api/swarm/users/adult') as never,
      { params: Promise.resolve({ handle: 'adult' }) },
    );

    expect(response.status).toBe(404);
    expect(mocks.findPosts).not.toHaveBeenCalled();
    expect(mocks.findUser).toHaveBeenCalledWith({
      where: {
        AND: [
          { handle: 'adult' },
          { nodeId: { isNull: true } },
        ],
      },
    });
  });
});
