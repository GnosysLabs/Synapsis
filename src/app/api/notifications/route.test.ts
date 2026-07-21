import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findNotifications: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/node/local-node', () => ({
  requireLocalNodeNsfwClassification: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/db', () => ({
  db: {
    query: {
      notifications: { findMany: mocks.findNotifications },
      users: { findMany: vi.fn().mockResolvedValue([]) },
    },
  },
  notifications: {},
}));

import { GET } from './route';

const remoteNotification = {
  id: 'notification-1',
  type: 'repost',
  createdAt: new Date('2026-07-17T00:00:00.000Z'),
  readAt: null,
  actorId: null,
  actorHandle: 'adult@adult.example',
  actorDisplayName: 'Adult',
  actorAvatarUrl: 'https://adult.example/stale-private-avatar.jpg',
  actorNodeDomain: 'adult.example',
  postId: null,
  remotePostId: 'post-1',
  remotePostDomain: 'adult.example',
  postContent: 'PRIVATE NOTIFICATION BODY',
  post: null,
};

describe('GET /api/notifications sensitive data enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({
      id: 'viewer-1',
      handle: 'viewer',
      nsfwEnabled: false,
    });
    mocks.findNotifications.mockResolvedValue([remoteNotification]);
  });

  it('withholds an NSFW remote actor avatar and post preview', async () => {
    const response = await GET(new Request('https://local.example/api/notifications'));
    const body = await response.json();

    expect(body.notifications[0]).toMatchObject({
      actor: { avatarUrl: null, handle: 'adult@adult.example', displayName: 'Adult' },
      post: { content: null, media: [], sensitiveRestricted: true },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('PRIVATE NOTIFICATION BODY');
    expect(serialized).not.toContain('fresh-private-avatar.jpg');
    expect(serialized).not.toContain('stale-private-avatar.jpg');
  });

  it('shows the stored remote display name to an age-confirmed NSFW viewer', async () => {
    mocks.requireAuth.mockResolvedValue({
      id: 'viewer-1',
      handle: 'viewer',
      nsfwEnabled: true,
      ageVerifiedAt: new Date('2026-07-01T00:00:00.000Z'),
    });

    const response = await GET(new Request('https://local.example/api/notifications'));
    const body = await response.json();

    expect(body.notifications[0].actor).toMatchObject({
      avatarUrl: 'https://adult.example/stale-private-avatar.jpg',
      handle: 'adult@adult.example',
      displayName: 'Adult',
      isNsfw: true,
      nodeIsNsfw: true,
    });
  });

  it('fails closed when the remote profile cannot be classified', async () => {
    const response = await GET(new Request('https://local.example/api/notifications'));
    const body = await response.json();

    expect(body.notifications[0].actor.avatarUrl).toBeNull();
    expect(body.notifications[0].post.content).toBeNull();
    expect(JSON.stringify(body)).not.toContain('stale-private-avatar.jpg');
    expect(JSON.stringify(body)).not.toContain('PRIVATE NOTIFICATION BODY');
  });
});
