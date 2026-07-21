import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const handleFindFirst = vi.fn();
  const userFindFirst = vi.fn();
  const updateSet = vi.fn();
  const insertValues = vi.fn();
  const tx = {
    query: {
      handleRegistry: { findFirst: handleFindFirst },
      users: { findFirst: userFindFirst },
    },
    update: vi.fn(() => ({
      set: (values: unknown) => {
        updateSet(values);
        return { where: vi.fn().mockResolvedValue([]) };
      },
    })),
    insert: vi.fn(() => ({
      values: (values: unknown) => {
        insertValues(values);
        return Promise.resolve();
      },
    })),
  };
  const transaction = vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx));
  return { handleFindFirst, userFindFirst, updateSet, insertValues, transaction, tx };
});

vi.mock('@/db', () => ({
  db: {
    transaction: mocks.transaction,
    query: { handleRegistry: { findFirst: mocks.handleFindFirst } },
  },
}));

import { generateDID, normalizeSigningPublicKey } from '@/lib/crypto/did-key';
import {
  refreshPinnedRemoteUserPresentation,
  upsertRemoteUser,
} from './user-cache';

const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const did = generateDID(publicKey);
const handle = 'alice@remote.social';

describe('verified remote user cache upgrades', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (callback: (value: typeof mocks.tx) => unknown) => (
      callback(mocks.tx)
    ));
  });

  it('replaces a legacy did:swarm hint after the handle has a verified binding', async () => {
    mocks.handleFindFirst.mockResolvedValue({ handle, did, identityVerified: true });
    mocks.userFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'legacy-user',
        handle,
        did: 'did:swarm:remote.social:alice',
        publicKey: 'legacy-node-asserted-key',
        displayName: 'Legacy Alice',
        avatarUrl: null,
        isNsfw: true,
      });

    await upsertRemoteUser({ handle, did, publicKey, displayName: 'alice' }, {
      identityVerified: true,
    });

    expect(mocks.updateSet).toHaveBeenCalledWith(expect.objectContaining({
      did,
      publicKey: normalizeSigningPublicKey(publicKey),
    }));
  });

  it('refuses cache changes without an exact verified handle binding', async () => {
    mocks.handleFindFirst.mockResolvedValue(null);

    await expect(upsertRemoteUser({ handle, did, publicKey, displayName: 'alice' }, {
      identityVerified: true,
    })).rejects.toThrow(/not verified/);
    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it('uses a supplied mutation transaction without opening a nested transaction', async () => {
    mocks.handleFindFirst.mockResolvedValue({ handle, did, identityVerified: true });
    mocks.userFindFirst.mockResolvedValue(null);

    await upsertRemoteUser({ handle, did, publicKey, displayName: 'alice' }, {
      identityVerified: true,
    }, mocks.tx as never);

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.insertValues).toHaveBeenCalledWith(expect.objectContaining({
      handle,
      did,
      publicKey: normalizeSigningPublicKey(publicKey),
    }));
  });

  it('does not merge a verified DID that already belongs to another handle', async () => {
    mocks.handleFindFirst.mockResolvedValue({ handle, did, identityVerified: true });
    mocks.userFindFirst
      .mockResolvedValueOnce({ id: 'other-user', handle: 'bob@remote.social', did })
      .mockResolvedValueOnce({
        id: 'legacy-user',
        handle,
        did: 'did:swarm:remote.social:alice',
      });

    await expect(upsertRemoteUser({ handle, did, publicKey, displayName: 'alice' }, {
      identityVerified: true,
    })).rejects.toThrow(/conflicts/);
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it('propagates an explicit avatar removal instead of reviving the stale cache', async () => {
    mocks.handleFindFirst.mockResolvedValue({ handle, did, identityVerified: true });
    mocks.userFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'remote-user',
        handle,
        did,
        publicKey,
        displayName: 'Alice',
        avatarUrl: 'https://remote.social/old-avatar.jpg',
        isNsfw: false,
      });

    await upsertRemoteUser({
      handle,
      did,
      publicKey,
      displayName: 'Alice',
      avatarUrl: null,
    }, { identityVerified: true });

    expect(mocks.updateSet).toHaveBeenCalledWith(expect.objectContaining({ avatarUrl: null }));
  });

  it('skips presentation refreshes until a signed action has pinned the identity', async () => {
    mocks.handleFindFirst.mockResolvedValue(null);

    await expect(refreshPinnedRemoteUserPresentation({
      handle,
      did,
      publicKey,
      displayName: 'Alice',
      avatarUrl: 'https://remote.social/new-avatar.jpg',
    })).resolves.toBe(false);
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });
});
