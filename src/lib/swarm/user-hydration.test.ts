import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetchSwarmUserProfile: vi.fn() }));

vi.mock('./interactions', () => ({
  fetchSwarmUserProfile: mocks.fetchSwarmUserProfile,
}));

import { hydrateSwarmUsers } from './user-hydration';

describe('hydrateSwarmUsers federation targets', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not fetch malformed, private, or mismatched asserted domains', async () => {
    const users = [
      { id: 'one', handle: 'alice@127.0.0.1', isRemote: true },
      { id: 'two', handle: 'alice@remote.social@other.social', isRemote: true },
      { id: 'three', handle: 'alice@remote.social', nodeDomain: 'other.social', isRemote: true },
    ];

    await hydrateSwarmUsers(users);

    expect(mocks.fetchSwarmUserProfile).not.toHaveBeenCalled();
  });

  it('hydrates a canonical public account from its asserted origin only', async () => {
    mocks.fetchSwarmUserProfile.mockResolvedValue({
      nodeDomain: 'remote.social',
      profile: {
        displayName: 'Alice',
        avatarUrl: null,
        bio: 'Hello',
        isNsfw: false,
        nodeIsNsfw: false,
      },
    });

    const [user] = await hydrateSwarmUsers([{
      id: 'alice',
      handle: 'Alice@REMOTE.SOCIAL',
      nodeDomain: 'remote.social',
      isRemote: true,
    }]);

    expect(mocks.fetchSwarmUserProfile).toHaveBeenCalledWith('alice', 'remote.social', 0);
    expect(user.displayName).toBe('Alice');
  });
});
