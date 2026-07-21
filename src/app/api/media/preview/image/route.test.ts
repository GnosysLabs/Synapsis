import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeFederationRequest: vi.fn(),
}));

vi.mock('@/lib/swarm/safe-federation-http', () => ({
  safeFederationRequest: mocks.safeFederationRequest,
}));
vi.mock('@/lib/rate-limit', () => ({
  isRateLimited: vi.fn(() => false),
}));

import { GET } from './route';

describe('GET /api/media/preview/image', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serves a bounded public image through the local node', async () => {
    mocks.safeFederationRequest.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
      body: Buffer.from('image-bytes'),
    });
    const url = 'https://cdn.mos.cms.futurecdn.net/preview.jpg';

    const response = await GET(new NextRequest(
      `https://node.social/api/media/preview/image?url=${encodeURIComponent(url)}`,
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('cache-control')).toContain('max-age=86400');
    expect(mocks.safeFederationRequest).toHaveBeenCalledWith(url, expect.objectContaining({
      maxResponseBytes: 1024 * 1024,
    }));
  });

  it('rejects non-image responses', async () => {
    mocks.safeFederationRequest.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from('<html>not an image</html>'),
    });

    const response = await GET(new NextRequest(
      'https://node.social/api/media/preview/image?url=https%3A%2F%2Fpcgamer.com%2Fpage',
    ));

    expect(response.status).toBe(404);
  });
});
