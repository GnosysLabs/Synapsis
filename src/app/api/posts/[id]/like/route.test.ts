import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findPost: vi.fn(),
  findLike: vi.fn(),
  findLegacyLike: vi.fn(),
  requireSignedAction: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: {
    query: {
      posts: { findFirst: mocks.findPost },
      likes: { findFirst: mocks.findLike },
      userSwarmLikes: { findFirst: mocks.findLegacyLike },
    },
  },
  posts: {},
  likes: {},
  notifications: {},
  remoteLikes: {},
  userSwarmLikes: {},
}));

vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn(),
}));

vi.mock('@/lib/auth/verify-signature', () => ({
  requireSignedAction: mocks.requireSignedAction,
}));

vi.mock('@/lib/swarm/remote-post-snapshot', () => ({
  fetchRemotePostSnapshot: vi.fn(),
}));

import { DELETE, POST } from './route';

const postId = '11111111-1111-4111-8111-111111111111';
const routeContext = { params: Promise.resolve({ id: postId }) };

function signedRequest(method: 'POST' | 'DELETE', action: 'like' | 'unlike') {
  return new Request(`https://node.social/api/posts/${postId}/like`, {
    method,
    body: JSON.stringify({
      action,
      did: 'did:key:test',
      handle: 'alice',
      ts: Date.now(),
      nonce: crypto.randomUUID(),
      sig: 'signature',
      data: { postId },
    }),
  });
}

describe('like desired-state mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'node.social');
    mocks.requireSignedAction.mockResolvedValue({
      id: 'user-1',
      handle: 'alice',
      displayName: 'Alice',
      avatarUrl: null,
      isSuspended: false,
      isSilenced: false,
    });
    mocks.findPost.mockResolvedValue({
      id: postId,
      userId: 'author-1',
      content: 'Hello',
      isRemoved: false,
      apId: null,
    });
    mocks.findLegacyLike.mockResolvedValue(null);
  });

  it('treats a repeated like as success', async () => {
    mocks.findLike.mockResolvedValue({ id: 'like-1', userId: 'user-1', postId });

    const response = await POST(signedRequest('POST', 'like'), routeContext);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, liked: true });
  });

  it('treats a repeated unlike as success', async () => {
    mocks.findLike.mockResolvedValue(null);

    const response = await DELETE(signedRequest('DELETE', 'unlike'), routeContext);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, liked: false });
  });
});
