import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getActiveSwarmNodes: vi.fn(),
  signedFederationRead: vi.fn(),
}));

vi.mock('./registry', () => ({
  getActiveSwarmNodes: mocks.getActiveSwarmNodes,
}));

vi.mock('./node-blocklist', () => ({
  filterBlockedDomains: vi.fn(async (domains: string[]) => domains),
  isNodeBlocked: vi.fn(async () => false),
  normalizeNodeDomain: vi.fn((domain: string) => (
    domain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '')
  )),
}));

vi.mock('./signed-read', () => ({
  signedFederationRead: mocks.signedFederationRead,
}));

vi.mock('@/lib/nsfw/content-visibility', () => ({
  isPostSensitive: vi.fn(() => false),
}));

import { fetchSwarmTimeline } from './timeline';

function searchPost(domain: string) {
  return {
    id: `post-${domain}`,
    content: 'Yolked!',
    createdAt: '2026-07-18T00:00:00.000Z',
    author: {
      handle: 'author',
      displayName: 'Author',
      isNsfw: false,
    },
    nodeDomain: domain,
    nodeIsNsfw: false,
    isNsfw: false,
    likeCount: 0,
    repostCount: 0,
    replyCount: 0,
  };
}

describe('fetchSwarmTimeline post search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'local.social');
    mocks.getActiveSwarmNodes.mockResolvedValue([
      { domain: 'alpha.social', isNsfw: false },
      { domain: 'beta.social', isNsfw: false },
    ]);
    mocks.signedFederationRead.mockImplementation(async (url: string) => {
      const domain = new URL(url).hostname;
      return {
        status: 200,
        json: () => ({ posts: [searchPost(domain)], nodeIsNsfw: false }),
      };
    });
  });

  it('queries known active peers with the content query under the node ceiling', async () => {
    const result = await fetchSwarmTimeline(undefined, 20, {
      query: 'Yolked',
      excludeDomains: new Set(['local.social']),
    });

    expect(mocks.getActiveSwarmNodes).toHaveBeenCalledWith(24);
    expect(mocks.signedFederationRead).toHaveBeenCalledTimes(2);
    for (const [url] of mocks.signedFederationRead.mock.calls) {
      const parsedUrl = new URL(url as string);
      expect(parsedUrl.pathname).toBe('/api/swarm/timeline');
      expect(parsedUrl.searchParams.get('q')).toBe('Yolked');
      expect(parsedUrl.searchParams.get('limit')).toBe('20');
    }
    expect(result.posts).toHaveLength(2);
    expect(result.sources.map((source) => source.domain)).toEqual([
      'alpha.social',
      'beta.social',
    ]);
  });
});
