/**
 * POST /api/posts endpoint tests
 * 
 * Tests for the create post endpoint with cryptographic signatures
 * Validates: Requirements US-3.1, US-3.2, US-3.3, US-3.4, US-3.5, TR-3
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET, POST } from './route';
import { getSession } from '@/lib/auth';
import { requireSignedAction } from '@/lib/auth/verify-signature';
import { requireCliSignedAction } from '@/lib/auth/cli-credentials';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { registerPostMentions } from '@/lib/mentions/delivery';

const mocks = vi.hoisted(() => ({
  insertValues: vi.fn(),
  findCollections: vi.fn(),
  deliverPostToSwarmFollowers: vi.fn().mockResolvedValue({ delivered: 0, failed: 0 }),
}));

// Mock the dependencies
vi.mock('@/lib/auth/verify-signature', () => ({
  requireSignedAction: vi.fn(),
  SignedActionError: class MockSignedActionError extends Error {
    readonly code: string;

    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));

vi.mock('@/lib/auth/cli-credentials', () => ({
  isCliSignedAction: (value: unknown) => Boolean(
    value && typeof value === 'object' && 'credentialId' in value,
  ),
  requireCliSignedAction: vi.fn(),
  signedActionErrorStatus: vi.fn(() => 403),
}));

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
  requireAuth: vi.fn(),
}));

vi.mock('@/lib/node/local-node', () => ({
  isLocalNodeNsfw: vi.fn(),
  requireLocalNodeNsfwClassification: vi.fn(),
}));

vi.mock('@/lib/mentions/delivery', () => ({
  registerPostMentions: vi.fn().mockResolvedValue({
    localNotifications: 0,
    remoteQueued: 0,
    skipped: 0,
  }),
}));

vi.mock('@/lib/swarm/interactions', () => ({
  deliverPostToSwarmFollowers: mocks.deliverPostToSwarmFollowers,
}));

vi.mock('@/db', () => {
  const database = {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown> | Array<Record<string, unknown>>) => {
        mocks.insertValues(values);
        const row: Record<string, unknown> = Array.isArray(values) ? {} : values;
        return {
          returning: vi.fn(() => Promise.resolve([{
            id: row.id || 'test-post-id',
            userId: row.userId || 'test-user-id',
            content: row.content || '',
            createdAt: new Date(),
            isRemoved: false,
            isNsfw: row.isNsfw || false,
            likesCount: 0,
            repostsCount: 0,
            repliesCount: 0,
          }])),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
    query: {
      media: {
        findMany: vi.fn(() => Promise.resolve([])),
      },
      posts: {
        findFirst: vi.fn(() => Promise.resolve(null)),
      },
      collections: {
        findMany: mocks.findCollections,
      },
    },
  };

  return {
    db: {
      ...database,
      transaction: vi.fn((callback: (tx: typeof database) => unknown) => callback(database)),
    },
    posts: {},
    users: {},
    media: {},
    collectionPosts: {},
  };
});

const clientPostId = '8d42ce12-7ba0-4c4f-841b-a0d7669fe652';

function signedPostData(content = 'Test post content') {
  return {
    clientPostId,
    content,
    mediaIds: [],
    mediaManifest: [],
    isNsfw: false,
  };
}

describe('POST /api/posts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findCollections.mockResolvedValue([]);
  });

  it('should accept a valid signed action and create a post', async () => {
    // Mock a valid user
    const mockUser = {
      id: 'test-user-id',
      did: 'did:synapsis:test123',
      handle: 'testuser',
      publicKey: 'test-public-key',
      isSuspended: false,
      isSilenced: false,
      isNsfw: false,
      postsCount: 0,
    };

    vi.mocked(requireSignedAction).mockResolvedValue(mockUser as Awaited<ReturnType<typeof requireSignedAction>>);

    // Create a signed action payload
    const signedAction = {
      action: 'post',
      data: signedPostData(),
      did: 'did:synapsis:test123',
      handle: 'testuser',
      ts: Date.now(),
      nonce: 'nonce-1',
      sig: 'test-signature',
    };

    // Create a mock request
    const request = new Request('http://localhost:43821/api/posts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(signedAction),
    });

    // Call the endpoint
    const response = await POST(request);
    const data = await response.json();

    // Verify the response
    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.post).toBeDefined();
    expect(data.post.content).toBe('Test post content');

    // Verify requireSignedAction was called
    expect(requireSignedAction).toHaveBeenCalledWith(signedAction, 'post');
    expect(mocks.insertValues).toHaveBeenCalledWith(expect.objectContaining({
      id: clientPostId,
      userId: 'test-user-id',
      content: 'Test post content',
    }));
    expect(registerPostMentions).toHaveBeenCalledWith(expect.objectContaining({
      postId: clientPostId,
      content: 'Test post content',
      userAction: signedAction,
    }));
  });

  it('derives durable YouTube embed metadata from signed post content', async () => {
    const mockUser = {
      id: 'test-user-id',
      did: 'did:synapsis:test123',
      handle: 'testuser',
      publicKey: 'test-public-key',
      isSuspended: false,
      isSilenced: false,
      isNsfw: false,
      postsCount: 0,
    };
    vi.mocked(requireSignedAction).mockResolvedValue(
      mockUser as Awaited<ReturnType<typeof requireSignedAction>>,
    );
    const youtubeUrl = 'https://www.youtube.com/watch?v=Y1t26WsnwCQ';
    const signedAction = {
      action: 'post',
      data: signedPostData(`Big changes in Diablo 4! ${youtubeUrl}`),
      did: mockUser.did,
      handle: mockUser.handle,
      ts: Date.now(),
      nonce: 'nonce-youtube-embed',
      sig: 'test-signature',
    };

    const response = await POST(new Request('http://localhost:43821/api/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signedAction),
    }));

    expect(response.status).toBe(200);
    expect(mocks.insertValues).toHaveBeenCalledWith(expect.objectContaining({
      linkPreviewUrl: youtubeUrl,
      linkPreviewTitle: 'YouTube',
      linkPreviewType: 'video',
    }));
  });

  it('rejects a new post containing a bare mention', async () => {
    const mockUser = {
      id: 'test-user-id',
      did: 'did:synapsis:test123',
      handle: 'testuser@synapsis.social',
      username: 'testuser',
      homeDomain: 'synapsis.social',
      isLocalAccount: true,
      publicKey: 'test-public-key',
      isSuspended: false,
      isSilenced: false,
      isNsfw: false,
      postsCount: 0,
    };
    vi.mocked(requireSignedAction).mockResolvedValue(
      mockUser as Awaited<ReturnType<typeof requireSignedAction>>,
    );
    const signedAction = {
      action: 'post',
      data: signedPostData('Hello @alice'),
      did: 'did:synapsis:test123',
      handle: 'testuser@synapsis.social',
      ts: Date.now(),
      nonce: 'nonce-bare-mention',
      sig: 'test-signature',
    };

    const response = await POST(new Request('http://localhost:43821/api/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signedAction),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Mentions must use canonical @handle@node addresses',
    });
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(registerPostMentions).not.toHaveBeenCalled();
  });

  it('creates collection memberships with the post in one transaction', async () => {
    const collectionIds = [
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ];
    const mockUser = {
      id: 'test-user-id',
      did: 'did:synapsis:test123',
      handle: 'testuser',
      publicKey: 'test-public-key',
      isSuspended: false,
      isSilenced: false,
      isNsfw: false,
      postsCount: 0,
    };
    vi.mocked(requireSignedAction).mockResolvedValue(mockUser as Awaited<ReturnType<typeof requireSignedAction>>);
    mocks.findCollections.mockResolvedValue(collectionIds.map((id) => ({ id })));
    const signedAction = {
      action: 'post',
      data: { ...signedPostData('Collected post'), collectionIds },
      did: 'did:synapsis:test123',
      handle: 'testuser',
      ts: Date.now(),
      nonce: 'nonce-collections',
      sig: 'test-signature',
    };

    const response = await POST(new Request('http://localhost:43821/api/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signedAction),
    }));

    expect(response.status).toBe(200);
    expect(mocks.findCollections).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        AND: [
          { id: { in: collectionIds } },
          { userId: 'test-user-id' },
        ],
      },
    }));
    expect(mocks.insertValues).toHaveBeenCalledWith(collectionIds.map((collectionId) => ({
      collectionId,
      postId: clientPostId,
    })));
  });

  it('rejects collection IDs that are not owned by the posting user', async () => {
    const collectionId = '22222222-2222-4222-8222-222222222222';
    const mockUser = {
      id: 'test-user-id',
      did: 'did:synapsis:test123',
      handle: 'testuser',
      publicKey: 'test-public-key',
      isSuspended: false,
      isSilenced: false,
      isNsfw: false,
      postsCount: 0,
    };
    vi.mocked(requireSignedAction).mockResolvedValue(mockUser as Awaited<ReturnType<typeof requireSignedAction>>);
    mocks.findCollections.mockResolvedValue([]);
    const signedAction = {
      action: 'post',
      data: { ...signedPostData('Collected post'), collectionIds: [collectionId] },
      did: 'did:synapsis:test123',
      handle: 'testuser',
      ts: Date.now(),
      nonce: 'nonce-wrong-collection',
      sig: 'test-signature',
    };

    const response = await POST(new Request('http://localhost:43821/api/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signedAction),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'A selected collection is not available',
    });
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it('accepts a delegated CLI action with post scope', async () => {
    const mockUser = {
      id: 'test-user-id',
      did: 'did:synapsis:test123',
      handle: 'testuser',
      publicKey: 'test-public-key',
      isSuspended: false,
      isSilenced: false,
      isNsfw: false,
      postsCount: 0,
    };
    vi.mocked(requireCliSignedAction).mockResolvedValue({
      user: mockUser,
      credential: { id: 'credential-1' },
    } as Awaited<ReturnType<typeof requireCliSignedAction>>);
    const cliAction = {
      action: 'post',
      data: { content: 'Posted from the CLI', mediaIds: [], isNsfw: false },
      credentialId: '00000000-0000-4000-8000-000000000001',
      ts: Date.now(),
      nonce: 'cli-nonce',
      sig: 'cli-signature',
    };

    const response = await POST(new Request('http://localhost:43821/api/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cliAction),
    }));

    expect(response.status).toBe(200);
    expect(requireCliSignedAction).toHaveBeenCalledWith(cliAction, 'post', 'posts:write');
    expect(requireSignedAction).not.toHaveBeenCalled();
  });

  it('should return 403 for invalid signature', async () => {
    // Mock signature verification failure
    vi.mocked(requireSignedAction).mockRejectedValue(new Error('Invalid signature'));

    const signedAction = {
      action: 'post',
      data: signedPostData(),
      did: 'did:synapsis:test123',
      handle: 'testuser',
      ts: Date.now(),
      nonce: 'nonce-2',
      sig: 'invalid-signature',
    };

    const request = new Request('http://localhost:43821/api/posts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(signedAction),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error).toBe('Invalid signature');
    expect(data.code).toBe('INVALID_SIGNATURE');
  });

  it('should return 403 for user not found', async () => {
    vi.mocked(requireSignedAction).mockRejectedValue(new Error('User not found'));

    const signedAction = {
      action: 'post',
      data: signedPostData(),
      did: 'did:synapsis:nonexistent',
      handle: 'nonexistent',
      ts: Date.now(),
      nonce: 'nonce-3',
      sig: 'test-signature',
    };

    const request = new Request('http://localhost:43821/api/posts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(signedAction),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error).toBe('User not found');
    expect(data.code).toBe('INVALID_SIGNATURE');
  });

  it('should return 403 for handle mismatch', async () => {
    vi.mocked(requireSignedAction).mockRejectedValue(new Error('Handle mismatch'));

    const signedAction = {
      action: 'post',
      data: signedPostData(),
      did: 'did:synapsis:test123',
      handle: 'wronghandle',
      ts: Date.now(),
      nonce: 'nonce-4',
      sig: 'test-signature',
    };

    const request = new Request('http://localhost:43821/api/posts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(signedAction),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error).toBe('Handle mismatch');
    expect(data.code).toBe('INVALID_SIGNATURE');
  });

  it('should return 403 for expired timestamp', async () => {
    vi.mocked(requireSignedAction).mockRejectedValue(new Error('Timestamp too old or in future'));

    const signedAction = {
      action: 'post',
      data: signedPostData(),
      did: 'did:synapsis:test123',
      handle: 'testuser',
      ts: Date.now() - 10 * 60 * 1000,
      nonce: 'nonce-5',
      sig: 'test-signature',
    };

    const request = new Request('http://localhost:43821/api/posts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(signedAction),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error).toBe('Timestamp too old or in future');
    expect(data.code).toBe('INVALID_SIGNATURE');
  });

  it('should return 403 for suspended user', async () => {
    const mockUser = {
      id: 'test-user-id',
      did: 'did:synapsis:test123',
      handle: 'testuser',
      publicKey: 'test-public-key',
      isSuspended: true,
      isSilenced: false,
      isNsfw: false,
      postsCount: 0,
    };

    vi.mocked(requireSignedAction).mockResolvedValue(mockUser as Awaited<ReturnType<typeof requireSignedAction>>);

    const signedAction = {
      action: 'post',
      data: signedPostData(),
      did: 'did:synapsis:test123',
      handle: 'testuser',
      ts: Date.now(),
      nonce: 'nonce-6',
      sig: 'test-signature',
    };

    const request = new Request('http://localhost:43821/api/posts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(signedAction),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error).toBe('Account restricted');
  });

  it('should return 400 for invalid post data', async () => {
    const mockUser = {
      id: 'test-user-id',
      did: 'did:synapsis:test123',
      handle: 'testuser',
      publicKey: 'test-public-key',
      isSuspended: false,
      isSilenced: false,
      isNsfw: false,
      postsCount: 0,
    };

    vi.mocked(requireSignedAction).mockResolvedValue(mockUser as Awaited<ReturnType<typeof requireSignedAction>>);

    const signedAction = {
      action: 'post',
      data: signedPostData(''), // Empty content should fail validation
      did: 'did:synapsis:test123',
      handle: 'testuser',
      ts: Date.now(),
      nonce: 'nonce-7',
      sig: 'test-signature',
    };

    const request = new Request('http://localhost:43821/api/posts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(signedAction),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Invalid input');
  });
});

describe('GET /api/posts?type=local', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an anonymous request for an NSFW node feed', async () => {
    vi.mocked(requireLocalNodeNsfwClassification).mockResolvedValue(true);
    vi.mocked(getSession).mockResolvedValue(null);

    const response = await GET(new Request('http://localhost:43821/api/posts?type=local'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: 'LOCAL_AUTH_REQUIRED',
    });
  });
});
