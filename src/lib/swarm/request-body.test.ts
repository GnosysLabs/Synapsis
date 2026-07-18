import { describe, expect, it } from 'vitest';
import { readLimitedJson } from './request-body';

describe('bounded federation JSON bodies', () => {
  it('parses a body below the byte limit', async () => {
    const request = new Request('https://node.social/inbox', {
      method: 'POST',
      body: JSON.stringify({ ok: true }),
    });
    await expect(readLimitedJson(request, 64)).resolves.toEqual({ ok: true });
  });

  it('rejects declared and streamed bodies above the byte limit', async () => {
    const declared = new Request('https://node.social/inbox', {
      method: 'POST',
      headers: { 'content-length': '1000' },
      body: '{}',
    });
    await expect(readLimitedJson(declared, 16)).rejects.toMatchObject({
      status: 413,
    });

    const streamed = new Request('https://node.social/inbox', {
      method: 'POST',
      body: JSON.stringify({ value: 'x'.repeat(100) }),
    });
    await expect(readLimitedJson(streamed, 16)).rejects.toMatchObject({
      status: 413,
    });
  });

  it('rejects malformed JSON as a client error', async () => {
    const request = new Request('https://node.social/inbox', {
      method: 'POST',
      body: '{broken',
    });
    await expect(readLimitedJson(request)).rejects.toMatchObject({
      status: 400,
    });
  });
});
