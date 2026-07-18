import { describe, expect, it } from 'vitest';

import { buildApnsPayload, notificationTitle, type PushEvent } from './apns';

const event: PushEvent = {
  eventId: '00000000-0000-4000-8000-000000000001',
  notificationId: '00000000-0000-4000-8000-000000000002',
  type: 'mention',
  actorName: 'Alice',
  postId: 'post-1',
  subscriptionId: '00000000-0000-4000-8000-000000000003',
};

describe('APNs payload', () => {
  it('contains routing metadata but no post content', () => {
    const payload = JSON.parse(buildApnsPayload(event));
    expect(payload.aps.alert.title).toBe('Alice mentioned you');
    expect(payload.synapsis).toEqual({
      notificationId: event.notificationId,
      type: 'mention',
      postId: 'post-1',
      subscriptionId: event.subscriptionId,
    });
    expect(JSON.stringify(payload)).not.toContain('postContent');
  });

  it('sanitizes actor names before displaying them', () => {
    expect(notificationTitle({ ...event, actorName: 'Alice\nInjected', type: 'follow' }))
      .toBe('Alice Injected followed you');
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
      title: 'Charlie sent you a message',
      body: 'Open Synapsis to read it.',
    });
    expect(payload.aps['thread-id']).toBe('messages');
    expect(payload.synapsis).toEqual({
      type: 'message',
      messageId: messageEvent.messageId,
      subscriptionId: messageEvent.subscriptionId,
    });
    expect(payload.synapsis).not.toHaveProperty('notificationId');
  });
});
