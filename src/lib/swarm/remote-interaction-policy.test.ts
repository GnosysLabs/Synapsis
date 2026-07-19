import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({
  db: { query: {} },
}));

import {
  shouldSuppressRemoteInteraction,
  type RemoteInteractionPolicyDatabase,
} from './remote-interaction-policy';

const actor = {
  did: 'did:key:remote-alice',
  handle: 'Alice',
  domain: 'REMOTE.social',
};

function policyDatabase() {
  const queries = {
    mutedNodes: { findFirst: vi.fn().mockResolvedValue(null) },
    users: { findFirst: vi.fn().mockResolvedValue(null) },
    blocks: { findFirst: vi.fn().mockResolvedValue(null) },
    mutes: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  return {
    queries,
    database: { query: queries } as unknown as RemoteInteractionPolicyDatabase,
  };
}

describe('remote interaction moderation policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('suppresses a muted node without looking up or materializing an actor', async () => {
    const { database, queries } = policyDatabase();
    queries.mutedNodes.findFirst.mockResolvedValue({ id: 'node-mute' });

    await expect(shouldSuppressRemoteInteraction(
      'recipient-id',
      actor,
      database,
    )).resolves.toBe(true);

    expect(queries.mutedNodes.findFirst).toHaveBeenCalledWith({
      where: { AND: [{ userId: 'recipient-id' }, { nodeDomain: 'remote.social' }] },
      columns: { id: true },
    });
    expect(queries.users.findFirst).not.toHaveBeenCalled();
  });

  it('allows the interaction when there is no cached remote actor', async () => {
    const { database, queries } = policyDatabase();

    await expect(shouldSuppressRemoteInteraction(
      'recipient-id',
      actor,
      database,
    )).resolves.toBe(false);

    expect(queries.users.findFirst).toHaveBeenNthCalledWith(1, {
      where: { did: actor.did },
      columns: { id: true, handle: true },
    });
    expect(queries.users.findFirst).toHaveBeenNthCalledWith(2, {
      where: { handle: 'alice@remote.social' },
      columns: { id: true, handle: true },
    });
    expect(queries.blocks.findFirst).not.toHaveBeenCalled();
    expect(queries.mutes.findFirst).not.toHaveBeenCalled();
  });

  it('suppresses bidirectional blocks against every cached actor representation', async () => {
    const { database, queries } = policyDatabase();
    queries.users.findFirst
      .mockResolvedValueOnce({ id: 'actor-by-did', handle: 'legacy@remote.social' })
      .mockResolvedValueOnce({ id: 'actor-by-handle', handle: 'alice@remote.social' });
    queries.blocks.findFirst.mockResolvedValue({ id: 'block' });

    await expect(shouldSuppressRemoteInteraction(
      'recipient-id',
      actor,
      database,
    )).resolves.toBe(true);

    const actorIds = { in: ['actor-by-did', 'actor-by-handle'] };
    expect(queries.blocks.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { AND: [{ userId: 'recipient-id' }, { blockedUserId: actorIds }] },
          { AND: [{ userId: actorIds }, { blockedUserId: 'recipient-id' }] },
        ],
      },
      columns: { id: true },
    });
  });

  it('suppresses a local mute but ignores a local account with a colliding DID', async () => {
    const muted = policyDatabase();
    muted.queries.users.findFirst
      .mockResolvedValueOnce({ id: 'remote-actor', handle: 'alice@remote.social' })
      .mockResolvedValueOnce({ id: 'remote-actor', handle: 'alice@remote.social' });
    muted.queries.mutes.findFirst.mockResolvedValue({ id: 'mute' });
    await expect(shouldSuppressRemoteInteraction(
      'recipient-id',
      actor,
      muted.database,
    )).resolves.toBe(true);

    const localCollision = policyDatabase();
    localCollision.queries.users.findFirst
      .mockResolvedValueOnce({ id: 'local-user', handle: 'alice' })
      .mockResolvedValueOnce(null);
    await expect(shouldSuppressRemoteInteraction(
      'recipient-id',
      actor,
      localCollision.database,
    )).resolves.toBe(false);
    expect(localCollision.queries.blocks.findFirst).not.toHaveBeenCalled();
  });
});
