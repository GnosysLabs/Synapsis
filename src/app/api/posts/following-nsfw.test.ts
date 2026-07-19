import { beforeEach, describe, expect, it, vi } from 'vitest';

const viewer = {
  id: 'viewer-1',
  handle: 'viewer',
  displayName: 'Viewer',
  avatarUrl: null,
  isNsfw: false,
  nsfwEnabled: false,
};

const sensitivePost = {
  id: 'sensitive-followed-post',
  userId: 'adult-user',
  content: 'FOLLOWING SECRET BODY',
  createdAt: new Date('2026-07-17T00:00:00.000Z'),
  isRemoved: false,
  isNsfw: true,
  likesCount: 0,
  repostsCount: 0,
  repliesCount: 0,
  replyToId: null,
  swarmReplyToId: null,
  repostOfId: null,
  linkPreviewUrl: 'https://adult.example/secret-story',
  linkPreviewTitle: 'FOLLOWING SECRET TITLE',
  linkPreviewDescription: 'FOLLOWING SECRET DESCRIPTION',
  linkPreviewImage: 'https://adult.example/secret-preview.jpg',
  linkPreviewType: 'card',
  linkPreviewVideoUrl: null,
  linkPreviewMediaJson: null,
  author: {
    id: 'adult-user',
    handle: 'adult',
    displayName: 'Adult',
    avatarUrl: 'https://adult.example/secret-avatar.jpg',
    isNsfw: true,
  },
  media: [{
    id: 'media-1',
    url: 'https://adult.example/secret-video.mp4',
    mimeType: 'video/mp4',
    altText: null,
  }],
  replyTo: null,
  repostOf: null,
};

const mocks = vi.hoisted(() => ({
  postFindMany: vi.fn(),
  userSwarmRepostFindMany: vi.fn(),
  getSession: vi.fn(),
  requireAuth: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getSession: mocks.getSession,
  requireAuth: mocks.requireAuth,
}));

vi.mock('@/lib/node/local-node', () => ({
  requireLocalNodeNsfwClassification: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ followingId: 'adult-user', nodeDomain: 'adult.example' }]),
      })),
    })),
    query: {
      posts: { findMany: mocks.postFindMany, findFirst: vi.fn() },
      userSwarmReposts: { findMany: mocks.userSwarmRepostFindMany },
      userSwarmLikes: { findMany: vi.fn().mockResolvedValue([]) },
      remoteFollows: { findMany: vi.fn().mockResolvedValue([]) },
      likes: { findMany: vi.fn().mockResolvedValue([]) },
      users: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn() },
      remoteReposts: { findMany: vi.fn().mockResolvedValue([]) },
    },
  },
  follows: { followingId: 'followingId', followerId: 'followerId' },
  likes: { postId: 'postId', userId: 'userId' },
  posts: { id: 'id', userId: 'userId', repostOfId: 'repostOfId', isRemoved: 'isRemoved' },
  users: { id: 'id' },
  media: {},
  remotePosts: {},
  remoteReposts: {},
  userSwarmLikes: {},
  userSwarmReposts: {},
  remoteFollows: {},
  mutes: {},
  blocks: {},
  mutedNodes: { nodeDomain: 'nodeDomain', userId: 'userId' },
}));

vi.mock('@/lib/swarm/node-blocklist', () => ({
  getBlockedNodeDomains: vi.fn().mockResolvedValue(new Set()),
}));

vi.mock('@/lib/swarm/content-cache', () => ({
  getCachedSwarmTimeline: vi.fn().mockResolvedValue({
    posts: [],
    sources: [],
    fetchedAt: '2026-07-18T00:00:00.000Z',
    continuationDate: null,
  }),
}));

import { GET } from './route';

describe('GET /api/posts?type=home sensitive Following enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: viewer });
    mocks.requireAuth.mockResolvedValue(viewer);
    mocks.postFindMany
      .mockResolvedValueOnce([sensitivePost])
      .mockResolvedValue([]);
    mocks.userSwarmRepostFindMany.mockResolvedValue([]);
  });

  it('does not ship raw followed-account NSFW data after viewing is disabled', async () => {
    const response = await GET(new Request('https://local.example/api/posts?type=home'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.posts).toMatchObject([{
      id: 'sensitive-followed-post',
      content: '',
      media: [],
      linkPreviewUrl: null,
      linkPreviewImage: null,
      sensitiveContentRestricted: true,
      author: { avatarUrl: null },
    }]);
    const serialized = JSON.stringify(body);
    for (const secret of [
      'FOLLOWING SECRET',
      'secret-avatar.jpg',
      'secret-video.mp4',
      'secret-preview.jpg',
      'secret-story',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
