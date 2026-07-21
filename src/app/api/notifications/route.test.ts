import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findNotifications: vi.fn(),
  findUsers: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/node/local-node', () => ({
  requireLocalNodeNsfwClassification: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/db', () => ({
  db: {
    query: {
      notifications: { findMany: mocks.findNotifications },
      users: { findMany: mocks.findUsers },
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

const degradedRemoteNotification = {
  ...remoteNotification,
  id: 'notification-new',
  createdAt: new Date('2026-07-18T00:00:00.000Z'),
  actorDisplayName: 'adult',
  actorAvatarUrl: null,
};

describe('GET /api/notifications sensitive data enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({
      id: 'viewer-1',
      handle: 'viewer',
      nsfwEnabled: false,
    });
    mocks.findNotifications.mockResolvedValue([degradedRemoteNotification, remoteNotification]);
    mocks.findUsers.mockResolvedValue([]);
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

  it('uses a cached remote profile when every notification snapshot is degraded', async () => {
    mocks.requireAuth.mockResolvedValue({
      id: 'viewer-1',
      handle: 'viewer',
      nsfwEnabled: true,
      ageVerifiedAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    mocks.findNotifications.mockResolvedValue([degradedRemoteNotification]);
    mocks.findUsers.mockResolvedValue([{
      id: 'cached-remote-user',
      handle: 'adult@adult.example',
      homeDomain: 'adult.example',
      isLocalAccount: false,
      displayName: 'Adult',
      avatarUrl: 'https://stuffbox.xyz/adult-avatar.jpg',
      isNsfw: true,
    }]);

    const response = await GET(new Request('https://local.example/api/notifications'));
    const body = await response.json();

    expect(body.notifications[0].actor).toMatchObject({
      handle: 'adult@adult.example',
      displayName: 'Adult',
      avatarUrl: 'https://stuffbox.xyz/adult-avatar.jpg',
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
