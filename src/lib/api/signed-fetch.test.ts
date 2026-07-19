import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSignedAction: vi.fn(),
  hasUserPrivateKey: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/crypto/user-signing', () => ({
  createSignedAction: mocks.createSignedAction,
  hasUserPrivateKey: mocks.hasUserPrivateKey,
}));

import { signedAPI } from './signed-fetch';

describe('signed post payloads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasUserPrivateKey.mockReturnValue(true);
    mocks.createSignedAction.mockResolvedValue({ sig: 'signed' });
    mocks.fetch.mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', mocks.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('strips presentation-only author fields before signing a swarm reply', async () => {
    const replyTarget = {
      postId: '11111111-1111-4111-8111-111111111111',
      nodeDomain: 'remote.social',
      content: 'Parent post',
      author: {
        id: 'remote-user-id',
        handle: 'alice',
        displayName: 'Alice',
        avatarUrl: 'https://remote.social/alice.jpg',
        nodeDomain: 'remote.social',
        bio: 'Must not enter the signed wire payload',
        isRemote: true,
        isNsfw: false,
      },
    };

    await signedAPI.createPost(
      'Reply',
      [],
      undefined,
      undefined,
      replyTarget,
      false,
      [],
      'did:key:alice',
      'alice',
    );

    expect(mocks.createSignedAction).toHaveBeenCalledWith(
      'post',
      expect.objectContaining({
        swarmReplyTo: {
          postId: replyTarget.postId,
          nodeDomain: 'remote.social',
          content: 'Parent post',
          author: {
            handle: 'alice',
            displayName: 'Alice',
            avatarUrl: 'https://remote.social/alice.jpg',
            nodeDomain: 'remote.social',
          },
        },
      }),
      'did:key:alice',
      'alice',
    );
  });

  it('includes selected collections in the signed post payload', async () => {
    const collectionIds = [
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ];

    await signedAPI.createPost(
      'Collected post',
      [],
      undefined,
      undefined,
      undefined,
      false,
      [],
      'did:key:alice',
      'alice',
      collectionIds,
    );

    expect(mocks.createSignedAction).toHaveBeenCalledWith(
      'post',
      expect.objectContaining({ collectionIds }),
      'did:key:alice',
      'alice',
    );
  });
});
