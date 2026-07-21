import { describe, expect, it } from 'vitest';

import { pushNotificationActorName } from './delivery';

describe('pushNotificationActorName', () => {
  it('uses the local actor display name', () => {
    expect(pushNotificationActorName({
      actorId: 'local-user-id',
      actorDisplayName: 'Alice',
      actorHandle: 'alice@local.example',
    })).toBe('Alice');
  });

  it('uses the verified handle for remote lock-screen notifications', () => {
    expect(pushNotificationActorName({
      actorId: null,
      actorDisplayName: 'Unverified presentation',
      actorHandle: 'alice@remote.example',
    })).toBe('alice@remote.example');
  });
});
