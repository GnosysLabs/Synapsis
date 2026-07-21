import { describe, expect, it } from 'vitest';

import { buildApnsPayload, notificationAction, notificationTitle, type PushEvent } from './apns';

const event: PushEvent = {
  eventId: '00000000-0000-4000-8000-000000000001',
  notificationId: '00000000-0000-4000-8000-000000000002',
  type: 'mention',
  actorName: 'Alice',
  actorAvatarUrl: 'https://cdn.example/alice.png',
  badge: 7,
  postId: 'post-1',
  subscriptionId: '00000000-0000-4000-8000-000000000003',
};

describe('APNs payload', () => {
  it('contains routing metadata but no post content', () => {
    const payload = JSON.parse(buildApnsPayload(event));
    expect(payload.aps.alert).toEqual({
      title: 'Alice',
      body: 'mentioned you',
    });
    expect(payload.aps.badge).toBe(7);
    expect(payload.synapsis).toEqual({
      notificationId: event.notificationId,
      type: 'mention',
      actorName: 'Alice',
      actorAvatarUrl: event.actorAvatarUrl,
      postId: 'post-1',
      subscriptionId: event.subscriptionId,
    });
    expect(JSON.stringify(payload)).not.toContain('postContent');
  });

  it('sanitizes actor names before displaying them', () => {
    expect(notificationTitle({ ...event, actorName: 'Alice\nInjected', type: 'follow' }))
      .toBe('Alice Injected');
    expect(notificationAction({ ...event, type: 'follow' })).toBe('followed you');
  });

  it('routes encrypted DMs to Messages without creating notification metadata', () => {
    const messageEvent: PushEvent = {
      eventId: '00000000-0000-4000-8000-000000000004',
      messageId: '00000000-0000-4000-8000-000000000005',
      type: 'message',
      actorName: 'Charlie',
      subscriptionId: '00000000-0000-4000-8000-000000000003',
    };
    const payload = JSON.parse(buildApnsPayload(messageEvent));

    expect(payload.aps.alert).toEqual({
      title: 'Charlie',
      body: 'sent you a DM',
    });
    expect(payload.aps['thread-id']).toBe('messages');
    expect(payload.synapsis).toEqual({
      type: 'message',
      actorName: 'Charlie',
      messageId: messageEvent.messageId,
      subscriptionId: messageEvent.subscriptionId,
    });
    expect(payload.synapsis).not.toHaveProperty('notificationId');
  });
});
