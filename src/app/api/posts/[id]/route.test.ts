import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  viewerAccess: vi.fn(),
  signedFederationRead: vi.fn(),
  knownNodeNsfw: vi.fn(),
  requireSignedAction: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: { query: {} },
  posts: {},
  users: {},
}));

vi.mock('@/lib/nsfw/viewer-access', () => ({
  getSensitiveContentViewerAccess: mocks.viewerAccess,
}));

vi.mock('@/lib/swarm/signed-read', () => ({
  signedFederationRead: mocks.signedFederationRead,
}));

vi.mock('@/lib/swarm/registry', () => ({
  getKnownSwarmNodeNsfw: mocks.knownNodeNsfw,
}));

vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn().mockRejectedValue(new Error('skip interaction lookup')),
}));

vi.mock('@/lib/auth/verify-signature', () => ({
  DELETE_ACTION_REQUESTS_PER_MINUTE: 10,
  requireSignedAction: mocks.requireSignedAction,
  SignedActionError: class SignedActionError extends Error {
    readonly code: string;

    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));

import { DELETE, GET } from './route';
import { SignedActionError } from '@/lib/auth/verify-signature';

const originPostId = '11111111-1111-4111-8111-111111111111';
const remoteReplyId = '22222222-2222-4222-8222-222222222222';

describe('GET /api/posts/[id] federated threads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'viewer.social');
    mocks.knownNodeNsfw.mockResolvedValue(false);
    mocks.viewerAccess.mockResolvedValue({
      viewer: { id: 'viewer', ageVerifiedAt: null },
      canViewSensitive: false,
      localNodeIsNsfw: false,
    });
    mocks.signedFederationRead.mockImplementation(async (url: string) => {
      if (url.includes('/api/swarm/replies?')) {
        return {
          status: 200,
          json: () => ({
            replies: [{
              id: remoteReplyId,
              content: 'Sensitive reply body',
              createdAt: '2026-07-18T00:01:00.000Z',
              nodeDomain: 'adult.social',
              likeCount: 2,
              repostCount: 3,
              replyCount: 4,
              isNsfw: true,
              nodeIsNsfw: true,
              author: {
                handle: 'alice',
                displayName: 'Alice',
                isNsfw: true,
                nodeIsNsfw: true,
              },
              media: [],
            }],
          }),
        };
      }

      return {
        status: 200,
        json: () => ({
          post: {
            id: originPostId,
            content: 'Public origin post',
            createdAt: '2026-07-18T00:00:00.000Z',
            isNsfw: false,
            nodeIsNsfw: false,
            author: {
              handle: 'origin_author',
              displayName: 'Origin Author',
              isNsfw: false,
              nodeIsNsfw: false,
              nodeDomain: 'origin.social',
            },
            media: [],
          },
          replies: [],
        }),
      };
    });
  });

  it('drops a cross-node reply relayed without its original user/node proof', async () => {
    const swarmId = `swarm:origin.social:${originPostId}`;
    const response = await GET(
      new Request(`https://viewer.social/api/posts/${encodeURIComponent(swarmId)}`),
      { params: Promise.resolve({ id: swarmId }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.signedFederationRead).toHaveBeenCalledWith(
      `https://origin.social/api/swarm/replies?postId=${originPostId}`,
      expect.any(Object),
    );
    expect(body.post.repliesCount).toBe(0);
    expect(body.replies).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('Sensitive reply body');
  });
});

describe('DELETE /api/posts/[id] errors', () => {
  it('returns an explanatory rate-limit response with retry guidance', async () => {
    mocks.requireSignedAction.mockRejectedValue(new SignedActionError('RATE_LIMITED'));
    const postId = '33333333-3333-4333-8333-333333333333';
    const response = await DELETE(new Request(`https://viewer.social/api/posts/${postId}`, {
      method: 'DELETE',
      body: JSON.stringify({
        action: 'delete',
        data: { postId },
        did: 'did:key:viewer',
        handle: 'viewer@viewer.social',
        ts: Date.now(),
        nonce: 'delete-rate-limit',
        sig: 'signature',
      }),
    }), { params: Promise.resolve({ id: postId }) });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    await expect(response.json()).resolves.toEqual({
      error: 'You can delete up to 10 posts per minute. This post was not deleted. Wait 60 seconds and try again.',
      code: 'RATE_LIMITED',
      limit: 10,
      windowSeconds: 60,
    });
  });
});
