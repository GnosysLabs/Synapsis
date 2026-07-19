import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isNodeBlocked: vi.fn(),
  signedFederationRead: vi.fn(),
}));

vi.mock('@/lib/swarm/node-blocklist', () => ({
  isNodeBlocked: mocks.isNodeBlocked,
}));

vi.mock('@/lib/swarm/signed-read', () => ({
  signedFederationRead: mocks.signedFederationRead,
}));

import { fetchRemoteCollectionDetail } from './federation';

describe('remote collection federation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isNodeBlocked.mockResolvedValue(false);
    mocks.signedFederationRead.mockResolvedValue({ status: 404 });
  });

  it('keeps collection detail responses inside the hardened federation ceiling', async () => {
    await fetchRemoteCollectionDetail(
      'alice',
      'remote.social',
      '11111111-1111-4111-8111-111111111111',
    );

    expect(mocks.signedFederationRead).toHaveBeenCalledWith(
      'https://remote.social/api/swarm/users/alice/collections/11111111-1111-4111-8111-111111111111',
      {
        headers: { Accept: 'application/json' },
        maxResponseBytes: 1024 * 1024,
      },
    );
  });
});
