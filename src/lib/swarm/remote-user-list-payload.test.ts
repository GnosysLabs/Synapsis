import { describe, expect, it } from 'vitest';

import { parseRemoteUserListResponse } from './remote-user-list-payload';

const timestamp = '2026-07-18T12:00:00.000Z';

describe('remote user list payloads', () => {
  it('canonicalizes source-owned and third-party summaries', () => {
    const entries = parseRemoteUserListResponse({
      followers: [
        {
          handle: 'ALICE',
          displayName: 'Alice',
          isRemote: false,
          nodeDomain: 'PEER.SYNAPSIS.SOCIAL',
        },
        {
          handle: 'BOB@BATORBROS.BOND',
          displayName: 'Bob',
          isRemote: true,
          nodeDomain: 'BATORBROS.BOND',
        },
      ],
      nodeDomain: 'PEER.SYNAPSIS.SOCIAL',
      timestamp,
    }, 'peer.synapsis.social', 'followers', 10);

    expect(entries).toMatchObject([
      {
        id: 'alice@peer.synapsis.social',
        handle: 'alice@peer.synapsis.social',
        nodeDomain: 'peer.synapsis.social',
        isRemote: true,
        isSourceOwned: true,
      },
      {
        id: 'bob@batorbros.bond',
        handle: 'bob@batorbros.bond',
        nodeDomain: 'batorbros.bond',
        isRemote: true,
        isSourceOwned: false,
      },
    ]);
  });

  it('enforces the requested response bound', () => {
    const entry = {
      handle: 'alice',
      displayName: 'Alice',
      isRemote: false,
      nodeDomain: 'peer.synapsis.social',
    };

    expect(() => parseRemoteUserListResponse({
      following: [entry, { ...entry, handle: 'bob' }],
      nodeDomain: 'peer.synapsis.social',
      timestamp,
    }, 'peer.synapsis.social', 'following', 1)).toThrow(
      'Remote user list entries failed validation',
    );
  });

  it('rejects a response that claims a different peer identity', () => {
    expect(() => parseRemoteUserListResponse({
      followers: [],
      nodeDomain: 'batorbros.bond',
      timestamp,
    }, 'peer.synapsis.social', 'followers', 10)).toThrow(
      'Remote user list returned a different node identity',
    );
  });

  it('rejects mismatched federated handles and node domains', () => {
    expect(() => parseRemoteUserListResponse({
      followers: [{
        handle: 'alice@batorbros.bond',
        displayName: 'Alice',
        isRemote: true,
        nodeDomain: 'synapsis.social',
      }],
      nodeDomain: 'peer.synapsis.social',
      timestamp,
    }, 'peer.synapsis.social', 'followers', 10)).toThrow(
      'Remote user list handle and node domain do not match',
    );
  });

  it('rejects unsafe media URLs', () => {
    expect(() => parseRemoteUserListResponse({
      followers: [{
        handle: 'alice',
        displayName: 'Alice',
        avatarUrl: 'http://127.0.0.1/private.png',
        isRemote: false,
        nodeDomain: 'peer.synapsis.social',
      }],
      nodeDomain: 'peer.synapsis.social',
      timestamp,
    }, 'peer.synapsis.social', 'followers', 10)).toThrow(
      'Remote user list entries failed validation',
    );
  });

  it('rejects unexpected response fields', () => {
    expect(() => parseRemoteUserListResponse({
      followers: [],
      nodeDomain: 'peer.synapsis.social',
      timestamp,
      attackerControlled: true,
    }, 'peer.synapsis.social', 'followers', 10)).toThrow(
      'Remote user list response failed validation',
    );
  });
});
