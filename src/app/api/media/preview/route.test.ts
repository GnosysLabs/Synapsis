import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveLinkPreview: vi.fn(),
}));

vi.mock('@/lib/media/resolveLinkPreview', () => ({
  resolveLinkPreview: mocks.resolveLinkPreview,
}));
vi.mock('@/lib/rate-limit', () => ({
  isRateLimited: vi.fn(() => false),
}));

import { GET } from './route';

describe('GET /api/media/preview', () => {
  it('recognizes YouTube without downloading the provider page', async () => {
    const sourceUrl = 'https://www.youtube.com/watch?v=Y1t26WsnwCQ';
    mocks.resolveLinkPreview.mockResolvedValue({
      url: sourceUrl,
      title: 'YouTube',
      description: null,
      image: null,
      type: 'video',
      videoUrl: null,
      media: null,
    });
    const response = await GET(new NextRequest(
      `http://localhost/api/media/preview?url=${encodeURIComponent(sourceUrl)}`,
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      url: sourceUrl,
      title: 'YouTube',
      type: 'video',
    });
    expect(mocks.resolveLinkPreview).toHaveBeenCalledWith(sourceUrl);
  });
});
