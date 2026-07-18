import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ safeFederationRequest: vi.fn() }));

vi.mock('@/lib/swarm/safe-federation-http', () => ({
  safeFederationRequest: mocks.safeFederationRequest,
}));

import { fetchGenericLinkPreview } from './genericPreview';

function response(contentType: string, html: string) {
  return {
    status: 200,
    headers: { 'content-type': contentType },
    text: () => html,
  };
}

describe('generic link previews', () => {
  beforeEach(() => mocks.safeFederationRequest.mockReset());

  it('uses the public-address-safe bounded requester', async () => {
    mocks.safeFederationRequest.mockResolvedValue(response(
      'text/html; charset=utf-8',
      '<title>Example</title><meta property="og:image" content="https://images.unsplash.com/image.jpg">',
    ));
    const preview = await fetchGenericLinkPreview('https://example.com/post');

    expect(preview?.title).toBe('Example');
    expect(preview?.image).toBe('https://images.unsplash.com/image.jpg');
    expect(mocks.safeFederationRequest).toHaveBeenCalledWith(
      'https://example.com/post',
      expect.objectContaining({ timeoutMs: 5_000, maxResponseBytes: 512 * 1024 }),
    );
  });

  it('rejects non-HTML responses and unsafe preview images', async () => {
    mocks.safeFederationRequest.mockResolvedValueOnce(response('application/json', '{}'));
    await expect(fetchGenericLinkPreview('https://example.com/post')).resolves.toBeNull();

    mocks.safeFederationRequest.mockResolvedValueOnce(response(
      'text/html',
      '<title>Example</title><meta property="og:image" content="http://127.0.0.1/secret">',
    ));
    await expect(fetchGenericLinkPreview('https://example.com/post')).resolves.toMatchObject({
      image: null,
      media: null,
    });
  });
});
