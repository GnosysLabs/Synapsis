import { describe, expect, it } from 'vitest';
import { storedProfilePresentation } from './stored-presentation';

const baseRemoteUser = {
  handle: 'alice@remote.example',
  displayName: 'Alice McExample',
  avatarUrl: 'https://remote.example/avatar.jpg',
  did: 'did:key:alice',
  isNsfw: false,
  isLocalAccount: false,
  homeDomain: 'remote.example',
  profileVersion: 500,
  profileDocumentJson: '{"signed":true}',
};

describe('storedProfilePresentation', () => {
  it('returns the signed remote name and avatar as one versioned presentation', () => {
    expect(storedProfilePresentation(baseRemoteUser, {
      localNodeDomain: 'local.example',
      localNodeIsNsfw: false,
      canViewSensitive: true,
    })).toMatchObject({
      handle: 'alice@remote.example',
      displayName: 'Alice McExample',
      avatarUrl: 'https://remote.example/avatar.jpg',
      profilePresentationVerified: true,
      profileVersion: 500,
    });
  });

  it('keeps identity but rejects an unsigned remote name and avatar', () => {
    expect(storedProfilePresentation({
      ...baseRemoteUser,
      displayName: 'Node Controlled Name',
      profileVersion: null,
      profileDocumentJson: null,
    }, {
      localNodeDomain: 'local.example',
      localNodeIsNsfw: false,
      canViewSensitive: true,
    })).toMatchObject({
      handle: 'alice@remote.example',
      displayName: 'alice',
      avatarUrl: null,
      did: 'did:key:alice',
      profilePresentationVerified: false,
      profileVersion: null,
    });
  });

  it('redacts sensitive avatar media without replacing the signed display name', () => {
    expect(storedProfilePresentation({
      ...baseRemoteUser,
      isNsfw: true,
    }, {
      localNodeDomain: 'local.example',
      localNodeIsNsfw: false,
      canViewSensitive: false,
    })).toMatchObject({
      displayName: 'Alice McExample',
      avatarUrl: null,
      sensitiveRestricted: true,
      profilePresentationVerified: true,
    });
  });
});
