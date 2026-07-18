import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  parseWebStream: vi.fn(),
}));

vi.mock('music-metadata', () => ({
  parseWebStream: mocks.parseWebStream,
}));

import { loadAudioMetadata } from './audio-metadata';

describe('loadAudioMetadata', () => {
  beforeEach(() => {
    mocks.parseWebStream.mockReset();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      location: { href: 'https://synapsis.example/feed' },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('scans bounded metadata from a normal track larger than the scan limit', async () => {
    const src = 'https://stuffbox.xyz/assets/large-track.mp3';
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      new Uint8Array([1, 2, 3]),
      {
        headers: {
          'content-length': String(12 * 1024 * 1024),
          'content-type': 'audio/mpeg',
        },
      },
    ));
    vi.stubGlobal('fetch', fetchMock);
    mocks.parseWebStream.mockResolvedValue({
      common: { title: 'Midnight Drive', artist: 'The Satellites' },
    });

    await expect(loadAudioMetadata(src)).resolves.toMatchObject({
      title: 'Midnight Drive',
      artist: 'The Satellites',
    });
    expect(mocks.parseWebStream).toHaveBeenCalledOnce();
  });

  it('never performs a metadata callback to an untrusted peer origin', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadAudioMetadata(
      'https://hostile-node.example/tracking/audio.mp3',
    )).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.parseWebStream).not.toHaveBeenCalled();
  });
});
