import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  parseBuffer: vi.fn(),
}));

vi.mock('music-metadata', () => ({
  parseBuffer: mocks.parseBuffer,
}));

import { loadAudioMetadata } from './audio-metadata';

describe('loadAudioMetadata', () => {
  beforeEach(() => {
    mocks.parseBuffer.mockReset();
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

  it('requests and parses a bounded first-byte range from a large track', async () => {
    const src = 'https://stuffbox.xyz/assets/large-track.mp3';
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      new Uint8Array([1, 2, 3]),
      {
        status: 206,
        headers: {
          'content-length': '3',
          'content-range': `bytes 0-2/${12 * 1024 * 1024}`,
          'content-type': 'audio/mpeg',
        },
      },
    ));
    vi.stubGlobal('fetch', fetchMock);
    mocks.parseBuffer.mockResolvedValue({
      common: { title: 'Midnight Drive', artist: 'The Satellites' },
    });

    await expect(loadAudioMetadata(src)).resolves.toMatchObject({
      title: 'Midnight Drive',
      artist: 'The Satellites',
    });
    expect(fetchMock).toHaveBeenCalledWith(src, expect.objectContaining({
      credentials: 'omit',
      headers: { Range: 'bytes=0-4194303' },
      referrerPolicy: 'no-referrer',
    }));
    expect(mocks.parseBuffer).toHaveBeenCalledOnce();
    expect(mocks.parseBuffer.mock.calls[0]?.[0]).toEqual(new Uint8Array([1, 2, 3]));
    expect(mocks.parseBuffer.mock.calls[0]?.[1]).toMatchObject({
      mimeType: 'audio/mpeg',
      size: 3,
      path: '/assets/large-track.mp3',
    });
  });

  it('still caps the response body when a storage server ignores the range', async () => {
    const src = 'https://stuffbox.xyz/assets/range-ignored.mp3';
    const oversizedChunk = new Uint8Array((4 * 1024 * 1024) + 1);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(oversizedChunk);
          controller.close();
        },
      }),
      { headers: { 'content-type': 'audio/mpeg' } },
    )));
    mocks.parseBuffer.mockResolvedValue({ common: { title: 'Bounded Track' } });

    await expect(loadAudioMetadata(src)).resolves.toMatchObject({ title: 'Bounded Track' });
    expect(mocks.parseBuffer.mock.calls[0]?.[0]).toHaveLength(4 * 1024 * 1024);
    expect(mocks.parseBuffer.mock.calls[0]?.[1]).toMatchObject({ size: 4 * 1024 * 1024 });
  });

  it('never performs a metadata callback to an untrusted peer origin', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadAudioMetadata(
      'https://hostile-node.example/tracking/audio.mp3',
    )).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.parseBuffer).not.toHaveBeenCalled();
  });
});
