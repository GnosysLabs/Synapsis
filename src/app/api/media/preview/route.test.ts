import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchGenericLinkPreview: vi.fn(),
  fetchRedditRichPreview: vi.fn(),
}));

vi.mock('@/lib/media/genericPreview', () => ({
  fetchGenericLinkPreview: mocks.fetchGenericLinkPreview,
}));
vi.mock('@/lib/media/redditPreview', () => ({
  fetchRedditRichPreview: mocks.fetchRedditRichPreview,
}));
vi.mock('@/lib/rate-limit', () => ({
  isRateLimited: vi.fn(() => false),
}));

import { GET } from './route';

describe('GET /api/media/preview', () => {
  it('recognizes YouTube without downloading the provider page', async () => {
    const sourceUrl = 'https://www.youtube.com/watch?v=Y1t26WsnwCQ';
    const response = await GET(new NextRequest(
      `http://localhost/api/media/preview?url=${encodeURIComponent(sourceUrl)}`,
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      url: sourceUrl,
      title: 'YouTube',
      type: 'video',
    });
    expect(mocks.fetchGenericLinkPreview).not.toHaveBeenCalled();
    expect(mocks.fetchRedditRichPreview).not.toHaveBeenCalled();
  });
});
