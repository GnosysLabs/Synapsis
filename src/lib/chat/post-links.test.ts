import { describe, expect, it } from 'vitest';

import {
  findChatPostLinks,
  parseChatPostLink,
  removeChatPostLinks,
  uniqueChatPostLinks,
} from './post-links';

const postId = '5a2cb9d2-4057-4f89-8f8e-329ebf8f499f';

describe('chat post links', () => {
  it('keeps same-node post IDs local', () => {
    expect(parseChatPostLink(
      `https://viewer.social/u/alice/posts/${postId}`,
      'viewer.social',
    )).toEqual({
      url: `https://viewer.social/u/alice/posts/${postId}`,
      postId,
    });
  });

  it('turns a post URL from another node into a federated post ID', () => {
    expect(parseChatPostLink(
      `https://source.social/u/alice/posts/${postId}`,
      'viewer.social',
    )).toEqual({
      url: `https://source.social/u/alice/posts/${postId}`,
      postId: `swarm:source.social:${postId}`,
    });
  });

  it('preserves canonical swarm IDs already present in a post URL', () => {
    const swarmId = `swarm:source.social:${postId}`;
    expect(parseChatPostLink(
      `https://viewer.social/u/alice@source.social/posts/${swarmId}`,
      'viewer.social',
    )?.postId).toBe(swarmId);
  });

  it('rejects lookalike, malformed, and unsafe links', () => {
    expect(parseChatPostLink(`https://source.social/posts/${postId}`, 'viewer.social')).toBeNull();
    expect(parseChatPostLink('https://source.social/u/alice/posts/not-a-uuid', 'viewer.social')).toBeNull();
    expect(parseChatPostLink(`javascript://source.social/u/alice/posts/${postId}`, 'viewer.social')).toBeNull();
  });

  it('extracts cards and removes their bare links without losing surrounding text', () => {
    const url = `https://source.social/u/alice/posts/${postId}`;
    const links = findChatPostLinks(`This is the one:\n${url}\nTake a look. ${url}`, 'viewer.social');

    expect(links).toHaveLength(2);
    expect(uniqueChatPostLinks(links)).toHaveLength(1);
    expect(removeChatPostLinks(`This is the one:\n${url}\nTake a look. ${url}`, links))
      .toBe('This is the one:\nTake a look.');
  });
});
