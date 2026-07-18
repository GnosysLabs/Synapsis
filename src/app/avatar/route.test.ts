import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('@/lib/swarm/safe-federation-http', () => ({
  safeFederationRequest: mocks.request,
}));

import { GET } from './route';

describe('generated avatar proxy', () => {
  beforeEach(() => {
    mocks.request.mockReset();
  });

  it('preserves the DiceBear style without exposing its origin to the browser', async () => {
    mocks.request.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'image/svg+xml' },
      text: () => '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
    });

    const response = await GET(new NextRequest(
      'https://synapsis.example/avatar?seed=cyph3r%40node.example',
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/svg+xml');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await response.text()).toContain('<svg');
    expect(mocks.request).toHaveBeenCalledWith(
      'https://api.dicebear.com/9.x/bottts-neutral/svg?seed=cyph3r%40node.example',
      expect.objectContaining({ maxResponseBytes: 128 * 1024 }),
    );
  });

  it('rejects unsafe upstream SVG even though the provider is fixed', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.request.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'image/svg+xml' },
      text: () => '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    });

    const response = await GET(new NextRequest(
      'https://synapsis.example/avatar?seed=unsafe-seed',
    ));
    expect(response.status).toBe(502);
    warning.mockRestore();
  });

  it('bounds the seed before making an upstream request', async () => {
    const response = await GET(new NextRequest('https://synapsis.example/avatar?seed='));
    expect(response.status).toBe(400);
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
