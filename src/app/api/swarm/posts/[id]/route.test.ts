import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorizeFederationRead: vi.fn(),
  localNodeIsNsfw: vi.fn(),
  findPost: vi.fn(),
  findReplies: vi.fn(),
}));

vi.mock('@/lib/swarm/signed-read', () => ({
  authorizeFederationRead: mocks.authorizeFederationRead,
  federationReadFailureResponse: (authorization: { status: number; code: string; error: string }) =>
    Response.json({ error: authorization.error, code: authorization.code }, { status: authorization.status }),
}));

vi.mock('@/lib/node/local-node', () => ({
  requireLocalNodeNsfwClassification: mocks.localNodeIsNsfw,
}));

vi.mock('@/db', () => ({
  db: {
    query: {
      posts: { findFirst: mocks.findPost, findMany: mocks.findReplies },
      userSwarmReposts: { findFirst: vi.fn().mockResolvedValue(null) },
      users: { findFirst: vi.fn().mockResolvedValue(null) },
      remoteReposts: { findMany: vi.fn().mockResolvedValue([]) },
    },
  },
}));

import { GET } from './route';

const postId = '11111111-1111-4111-8111-111111111111';
const secretPost = {
  id: postId,
  apId: `https://local.example/posts/${postId}`,
  content: 'PRIVATE DIRECT FEDERATION BODY',
  createdAt: new Date('2026-07-17T00:00:00.000Z'),
  isRemoved: false,
  isNsfw: true,
  likesCount: 0,
  repostsCount: 0,
  repliesCount: 0,
  linkPreviewUrl: 'https://adult.example/private-story',
  linkPreviewTitle: 'PRIVATE DIRECT TITLE',
  linkPreviewDescription: 'PRIVATE DIRECT DESCRIPTION',
  linkPreviewImage: 'https://adult.example/private-preview.jpg',
  linkPreviewType: 'card',
  linkPreviewVideoUrl: null,
  linkPreviewMediaJson: null,
  author: {
    id: 'author-1',
    handle: 'author',
    nodeId: null,
    displayName: 'Author',
    avatarUrl: 'https://adult.example/private-avatar.jpg',
    isNsfw: true,
  },
  media: [{
    url: 'https://adult.example/private-video.mp4',
    altText: null,
  }],
};

describe('GET /api/swarm/posts/[id] read authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'local.example');
    mocks.localNodeIsNsfw.mockResolvedValue(false);
    mocks.authorizeFederationRead.mockResolvedValue({ ok: true, sourceDomain: 'peer.example' });
    mocks.findPost.mockResolvedValue(secretPost);
    mocks.findReplies.mockResolvedValue([]);
  });

  it('denies an unsigned direct sensitive-post request without returning raw data', async () => {
    mocks.authorizeFederationRead.mockResolvedValue({
      ok: false, status: 401, code: 'FEDERATION_AUTH_REQUIRED', error: 'Authenticated federation read required',
    });
    const response = await GET(
      new Request(`https://local.example/api/swarm/posts/${postId}`) as never,
      { params: Promise.resolve({ id: postId }) },
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    const serialized = JSON.stringify(body);
    for (const secret of [
      'PRIVATE',
      'private-avatar.jpg',
      'private-video.mp4',
      'private-preview.jpg',
      'private-story',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('returns the full post only to a trusted signed peer', async () => {
    const response = await GET(
      new Request(`https://local.example/api/swarm/posts/${postId}`) as never,
      { params: Promise.resolve({ id: postId }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.post.content).toBe('PRIVATE DIRECT FEDERATION BODY');
    expect(body.post.media[0].url).toContain('private-video.mp4');
  });

  it('does not expose a safe post or its sensitive replies to an unsigned caller', async () => {
    mocks.authorizeFederationRead.mockResolvedValue({
      ok: false, status: 401, code: 'FEDERATION_AUTH_REQUIRED', error: 'Authenticated federation read required',
    });
    mocks.findPost.mockResolvedValue({
      ...secretPost,
      content: 'Public body',
      isNsfw: false,
      author: { ...secretPost.author, avatarUrl: null, isNsfw: false },
      media: [],
      linkPreviewUrl: null,
      linkPreviewTitle: null,
      linkPreviewDescription: null,
      linkPreviewImage: null,
    });
    mocks.findReplies.mockResolvedValue([{
      ...secretPost,
      id: '22222222-2222-4222-8222-222222222222',
      content: 'PRIVATE REPLY BODY',
    }]);

    const response = await GET(
      new Request(`https://local.example/api/swarm/posts/${postId}`) as never,
      { params: Promise.resolve({ id: postId }) },
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.post).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('PRIVATE REPLY BODY');
  });

  it('rejects a cached remote main author even when its handle is unqualified', async () => {
    mocks.findPost.mockResolvedValue({
      ...secretPost,
      author: {
        ...secretPost.author,
        handle: 'remote-placeholder',
        nodeId: 'remote-node-id',
      },
    });

    const response = await GET(
      new Request(`https://local.example/api/swarm/posts/${postId}`) as never,
      { params: Promise.resolve({ id: postId }) },
    );

    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain('PRIVATE DIRECT FEDERATION BODY');
  });

  it('filters cached remote replies identified by nodeId even with an unqualified handle', async () => {
    mocks.findPost.mockResolvedValue({
      ...secretPost,
      content: 'Public body',
      isNsfw: false,
      author: { ...secretPost.author, isNsfw: false },
    });
    mocks.findReplies.mockResolvedValue([{
      ...secretPost,
      id: '22222222-2222-4222-8222-222222222222',
      content: 'REMOTE REPLY MUST NOT BE EXPORTED',
      isNsfw: false,
      author: {
        ...secretPost.author,
        handle: 'remote-placeholder',
        nodeId: 'remote-node-id',
        isNsfw: false,
      },
    }]);

    const response = await GET(
      new Request(`https://local.example/api/swarm/posts/${postId}`) as never,
      { params: Promise.resolve({ id: postId }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.replies).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('REMOTE REPLY MUST NOT BE EXPORTED');
  });
});
