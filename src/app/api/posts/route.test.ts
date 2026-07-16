/**
 * POST /api/posts endpoint tests
 * 
 * Tests for the create post endpoint with cryptographic signatures
 * Validates: Requirements US-3.1, US-3.2, US-3.3, US-3.4, US-3.5, TR-3
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './route';
import { requireSignedAction } from '@/lib/auth/verify-signature';

// Mock the dependencies
vi.mock('@/lib/auth/verify-signature', () => ({
  requireSignedAction: vi.fn(),
}));

vi.mock('@/lib/mentions/delivery', () => ({
  registerPostMentions: vi.fn().mockResolvedValue({
    localNotifications: 0,
    remoteQueued: 0,
    skipped: 0,
  }),
}));

vi.mock('@/db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{
          id: 'test-post-id',
          userId: 'test-user-id',
          content: 'Test post content',
          createdAt: new Date(),
          isRemoved: false,
          isNsfw: false,
          likesCount: 0,
          repostsCount: 0,
          repliesCount: 0,
        }])),
      })),
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
    },
  },
  posts: {},
  users: {},
  media: {},
}));

describe('POST /api/posts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      data: {
        content: 'Test post content',
        mediaIds: [],
        isNsfw: false,
      },
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
    expect(requireSignedAction).toHaveBeenCalledWith(signedAction);
  });

  it('should return 403 for invalid signature', async () => {
    // Mock signature verification failure
    vi.mocked(requireSignedAction).mockRejectedValue(new Error('Invalid signature'));

    const signedAction = {
      action: 'post',
      data: {
        content: 'Test post content',
      },
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
      data: {
        content: 'Test post content',
      },
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
      data: {
        content: 'Test post content',
      },
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
      data: {
        content: 'Test post content',
      },
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
      data: {
        content: 'Test post content',
      },
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
      data: {
        content: '', // Empty content should fail validation
      },
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
