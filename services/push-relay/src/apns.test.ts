import { describe, expect, it } from 'vitest';

import { buildApnsPayload, notificationTitle, type PushEvent } from './apns';

const event: PushEvent = {
  eventId: '00000000-0000-4000-8000-000000000001',
  notificationId: '00000000-0000-4000-8000-000000000002',
  type: 'mention',
  actorName: 'Alice',
  postId: 'post-1',
};

describe('APNs payload', () => {
  it('contains routing metadata but no post content', () => {
    const payload = JSON.parse(buildApnsPayload(event));
    expect(payload.aps.alert.title).toBe('Alice mentioned you');
    expect(payload.synapsis).toEqual({
      notificationId: event.notificationId,
      type: 'mention',
      postId: 'post-1',
    });
    expect(JSON.stringify(payload)).not.toContain('postContent');
  });

  it('sanitizes actor names before displaying them', () => {
    expect(notificationTitle({ ...event, actorName: 'Alice\nInjected', type: 'follow' }))
      .toBe('Alice Injected followed you');
  });
});
