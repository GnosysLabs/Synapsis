import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  isNodeBlocked: vi.fn(),
  safeFederationRequest: vi.fn(),
  usersFindFirst: vi.fn(),
  remoteBundleFindFirst: vi.fn(),
  normalizedHandleRows: vi.fn(),
  transaction: vi.fn(),
  insertValues: vi.fn(),
  insertResult: vi.fn(),
  pinVerifiedFederatedActorIdentity: vi.fn(),
  events: [] as string[],
}));

vi.mock('@/lib/auth', () => ({ getSession: mocks.getSession }));

vi.mock('@/lib/swarm/node-blocklist', () => ({
  isNodeBlocked: mocks.isNodeBlocked,
  normalizeNodeDomain: (value: string) => value.trim().toLowerCase(),
}));

vi.mock('@/lib/swarm/safe-federation-http', () => ({
  safeFederationRequest: mocks.safeFederationRequest,
}));

vi.mock('@/lib/swarm/federated-action', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/swarm/federated-action')>();
  return {
    ...actual,
    pinVerifiedFederatedActorIdentity: mocks.pinVerifiedFederatedActorIdentity,
  };
});

vi.mock('@/db', () => {
  const e2eeRemoteKeyBundles = {
    did: 'e2eeRemoteKeyBundles.did',
    handle: 'e2eeRemoteKeyBundles.handle',
    signingPublicKey: 'e2eeRemoteKeyBundles.signingPublicKey',
    keyId: 'e2eeRemoteKeyBundles.keyId',
    keyVersion: 'e2eeRemoteKeyBundles.keyVersion',
    publicKey: 'e2eeRemoteKeyBundles.publicKey',
  };
  const handleRegistry = {
    handle: 'handleRegistry.handle',
    did: 'handleRegistry.did',
    nodeDomain: 'handleRegistry.nodeDomain',
    identityVerified: 'handleRegistry.identityVerified',
  };
  const tx = {
    query: {
      e2eeRemoteKeyBundles: { findFirst: mocks.remoteBundleFindFirst },
    },
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({ limit: () => mocks.normalizedHandleRows() }),
      }),
    })),
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => {
        mocks.events.push('cache');
        mocks.insertValues(values);
        return {
          onConflictDoNothing: () => ({ returning: () => mocks.insertResult() }),
        };
      },
    })),
    update: vi.fn(() => ({
      set: () => ({
        where: () => ({ returning: async () => [{ did: 'updated' }] }),
      }),
    })),
  };
  mocks.transaction.mockImplementation(async (callback: (transaction: typeof tx) => unknown) => (
    callback(tx)
  ));

  return {
    db: {
      query: { users: { findFirst: mocks.usersFindFirst } },
      transaction: mocks.transaction,
    },
    e2eeRemoteKeyBundles,
    handleRegistry,
  };
});

import { generateDID } from '@/lib/crypto/did-key';
import { generateKeyPair as generatePemKeyPair } from '@/lib/crypto/keys';
import {
  clearUserPrivateKey,
  createSignedAction,
  importPrivateKey,
  keyStore,
} from '@/lib/crypto/user-signing';
import { verifyE2EEPublicBundle } from '@/lib/e2ee/bundle-proof';
import { generateE2EEKeyMaterial } from '@/lib/e2ee/client-crypto';
import { E2EE_PROTOCOL } from '@/lib/e2ee/protocol';
import { FederatedIdentityContinuityError } from '@/lib/swarm/federated-action';
import { createSignedAccountMoveNotice, verifySignedAccountMoveNotice } from '@/lib/account/move-notification';
import { GET } from './route';

function pemBody(pem: string): Uint8Array {
  return Uint8Array.from(Buffer.from(
    pem
      .replace(/-----BEGIN PRIVATE KEY-----/g, '')
      .replace(/-----END PRIVATE KEY-----/g, '')
      .replace(/\s/g, ''),
    'base64',
  ));
}

async function createValidSelfSignedBundle(handle = 'alice') {
  const signingKeys = await generatePemKeyPair();
  const did = generateDID(signingKeys.publicKey);
  keyStore.setPrivateKey(await importPrivateKey(pemBody(signingKeys.privateKey)));
  const encryptionKeys = await generateE2EEKeyMaterial();
  const bundle = {
    protocol: E2EE_PROTOCOL,
    keyId: encryptionKeys.keyId,
    version: 1,
    publicKey: encryptionKeys.publicKey,
    createdAt: Date.now(),
    recoveryCommitment: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  } as const;
  const proof = await createSignedAction('e2ee_key_bundle', bundle, did, handle);
  return {
    did,
    privateKey: signingKeys.privateKey,
    response: { bundle, proof, signingPublicKey: signingKeys.publicKey },
  };
}

function resolveRequest(did: string) {
  return new NextRequest(
    `https://local.social/api/e2ee/keys/resolve?did=${encodeURIComponent(did)}&handle=alice%40remote.social`,
  );
}

describe('remote E2EE handle identity continuity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    mocks.getSession.mockResolvedValue({ user: { id: 'local-user' } });
    mocks.usersFindFirst.mockResolvedValue(null);
    mocks.isNodeBlocked.mockResolvedValue(false);
    mocks.remoteBundleFindFirst.mockResolvedValue(null);
    mocks.normalizedHandleRows.mockResolvedValue([]);
    mocks.insertResult.mockResolvedValue([{ did: 'inserted' }]);
    mocks.pinVerifiedFederatedActorIdentity.mockImplementation(async () => {
      mocks.events.push('pin');
      return {
        sourceDomain: 'remote.social',
        actorHandle: 'alice',
        qualifiedHandle: 'alice@remote.social',
      };
    });
  });

  afterEach(() => clearUserPrivateKey());

  it('atomically pins first-contact TOFU identity with its verified encryption bundle', async () => {
    const attacker = await createValidSelfSignedBundle();
    mocks.safeFederationRequest.mockResolvedValue({
      status: 200,
      json: () => attacker.response,
    });

    const response = await GET(resolveRequest(attacker.did));

    expect(response.status).toBe(200);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.events).toEqual(['pin', 'cache']);
    expect(mocks.pinVerifiedFederatedActorIdentity).toHaveBeenCalledWith({
      sourceDomain: 'remote.social',
      actorHandle: 'alice@remote.social',
      did: attacker.did,
    }, expect.anything());
    expect(mocks.insertValues).toHaveBeenCalledWith(expect.objectContaining({
      did: attacker.did,
      handle: 'alice@remote.social',
    }));
  });

  it('rejects a valid self-signed attacker DID when the handle has an established pin', async () => {
    const attacker = await createValidSelfSignedBundle();
    expect(await verifyE2EEPublicBundle(attacker.response, attacker.did)).toBe(true);
    mocks.safeFederationRequest.mockResolvedValue({
      status: 200,
      json: () => attacker.response,
    });
    mocks.pinVerifiedFederatedActorIdentity.mockImplementation(async () => {
      mocks.events.push('pin');
      throw new FederatedIdentityContinuityError();
    });

    const response = await GET(resolveRequest(attacker.did));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'E2EE_IDENTITY_KEY_CHANGED',
    });
    expect(mocks.events).toEqual(['pin']);
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it('rejects a legacy cached bundle that maps the same handle to another DID', async () => {
    const attacker = await createValidSelfSignedBundle();
    mocks.safeFederationRequest.mockResolvedValue({
      status: 200,
      json: () => attacker.response,
    });
    mocks.normalizedHandleRows.mockResolvedValue([{
      did: 'did:key:previous-owner',
      handle: '@Alice@REMOTE.SOCIAL',
    }]);

    const response = await GET(resolveRequest(attacker.did));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'E2EE_IDENTITY_KEY_CHANGED',
    });
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it('accepts the same DID and E2EE key at its new handle with a valid signed move notice', async () => {
    const moved = await createValidSelfSignedBundle('alice@old.social');
    const moveNotice = createSignedAccountMoveNotice({
      oldHandle: 'alice@old.social',
      newActorUrl: 'https://remote.social/users/alice',
      did: moved.did,
      privateKey: moved.privateKey,
    });
    expect(verifySignedAccountMoveNotice(moveNotice, moved.response.signingPublicKey)).toBe(true);
    expect(await verifyE2EEPublicBundle(moved.response, moved.did)).toBe(true);
    mocks.safeFederationRequest.mockResolvedValue({
      status: 200,
      json: () => ({ ...moved.response, moveNotice }),
    });
    mocks.remoteBundleFindFirst.mockResolvedValue({
      did: moved.did,
      handle: 'alice@old.social',
      signingPublicKey: moved.response.signingPublicKey,
      keyId: moved.response.bundle.keyId,
      keyVersion: moved.response.bundle.version,
      publicKey: moved.response.bundle.publicKey,
    });

    const response = await GET(resolveRequest(moved.did));

    expect(response.status).toBe(200);
    expect(mocks.pinVerifiedFederatedActorIdentity).toHaveBeenCalledWith({
      sourceDomain: 'remote.social',
      actorHandle: 'alice@remote.social',
      did: moved.did,
    }, expect.anything());
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });
});
