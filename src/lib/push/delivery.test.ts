import { describe, expect, it } from 'vitest';

import {
  pushActorAvatarUrl,
  pushActorAvatarUrlForViewer,
  pushDiceBearAvatarUrl,
  pushNotificationActorName,
} from './delivery';

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

describe('pushActorAvatarUrlForViewer', () => {
  const customAvatar = 'https://cdn.example/alice-private.png';
  const base = {
    actorHandle: 'alice@adult.example',
    actorNodeDomain: 'adult.example',
    actorAvatarUrl: customAvatar,
    actorAccountIsNsfw: false,
    actorNodeIsNsfw: false,
    actorIsRemote: true,
    recipientNsfwEnabled: false,
    recipientAgeVerifiedAt: null,
    localNodeIsNsfw: false,
  };
  const placeholder = pushDiceBearAvatarUrl(base.actorHandle, base.actorNodeDomain);

  it('replaces an adult account avatar for a recipient without adult access', () => {
    expect(pushActorAvatarUrlForViewer({
      ...base,
      actorAccountIsNsfw: true,
    })).toBe(placeholder);
  });

  it('replaces an adult-node avatar for a recipient without adult access', () => {
    expect(pushActorAvatarUrlForViewer({
      ...base,
      actorNodeIsNsfw: true,
    })).toBe(placeholder);
  });

  it('requires age verification even when the recipient enabled adult content', () => {
    expect(pushActorAvatarUrlForViewer({
      ...base,
      actorAccountIsNsfw: true,
      recipientNsfwEnabled: true,
    })).toBe(placeholder);
  });

  it('shows the custom avatar when an age-verified recipient enabled adult content', () => {
    expect(pushActorAvatarUrlForViewer({
      ...base,
      actorAccountIsNsfw: true,
      recipientNsfwEnabled: true,
      recipientAgeVerifiedAt: new Date(),
    })).toBe(customAvatar);
  });

  it('allows age-verified users on adult nodes without a redundant toggle', () => {
    expect(pushActorAvatarUrlForViewer({
      ...base,
      actorNodeIsNsfw: true,
      recipientAgeVerifiedAt: new Date(),
      localNodeIsNsfw: true,
    })).toBe(customAvatar);
  });

  it('fails closed when a remote actor classification is incomplete', () => {
    expect(pushActorAvatarUrlForViewer({
      ...base,
      actorAccountIsNsfw: undefined,
    })).toBe(placeholder);
  });

  it('keeps a safe custom avatar for a known general-audience actor', () => {
    expect(pushActorAvatarUrlForViewer(base)).toBe(customAvatar);
  });

  it('uses the same canonical DiceBear seed for bare and qualified handles', () => {
    expect(pushDiceBearAvatarUrl('alice', 'adult.example'))
      .toBe(pushDiceBearAvatarUrl('alice@adult.example'));
  });
});
