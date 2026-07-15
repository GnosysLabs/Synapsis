import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasNewStuffboxConnection } from './browser-upload';

afterEach(() => vi.unstubAllGlobals());

describe('hasNewStuffboxConnection', () => {
  it('accepts a connection saved after the current attempt started', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      provider: 'stuffbox',
      stuffboxUpdatedAt: '2026-07-15T06:00:01.000Z',
    }), { status: 200 })));

    await expect(hasNewStuffboxConnection('2026-07-15T06:00:00.000Z')).resolves.toBe(true);
  });

  it('does not mistake an older connection for completion of a new attempt', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      provider: 'stuffbox',
      stuffboxUpdatedAt: '2026-07-15T05:59:59.000Z',
    }), { status: 200 })));

    await expect(hasNewStuffboxConnection('2026-07-15T06:00:00.000Z')).resolves.toBe(false);
  });
});

