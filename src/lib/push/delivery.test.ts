import { describe, expect, it } from 'vitest';

import { pushActorAvatarUrl, pushNotificationActorName } from './delivery';

describe('pushNotificationActorName', () => {
  it('uses the local actor display name', () => {
    expect(pushNotificationActorName({
      actorId: 'local-user-id',
      actorDisplayName: 'Alice',
      actorHandle: 'alice@local.example',
    })).toBe('Alice');
  });

  it('uses the remote actor display name on lock-screen notifications', () => {
    expect(pushNotificationActorName({
      actorId: null,
      actorDisplayName: 'Alice Remote',
      actorHandle: 'alice@remote.example',
    })).toBe('Alice Remote');
  });

  it('falls back to the canonical handle when the display name is empty', () => {
    expect(pushNotificationActorName({
      actorId: null,
      actorDisplayName: '   ',
      actorHandle: 'alice@remote.example',
    })).toBe('alice@remote.example');
  });
});

describe('pushActorAvatarUrl', () => {
  it('accepts HTTPS avatars and drops unsafe or malformed values', () => {
    expect(pushActorAvatarUrl('https://cdn.example/alice.png')).toBe('https://cdn.example/alice.png');
    expect(pushActorAvatarUrl('http://cdn.example/alice.png')).toBeUndefined();
    expect(pushActorAvatarUrl('https://user:secret@cdn.example/alice.png')).toBeUndefined();
    expect(pushActorAvatarUrl('not a URL')).toBeUndefined();
  });
});
