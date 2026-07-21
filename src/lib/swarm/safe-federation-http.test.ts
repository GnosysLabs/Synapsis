import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  E2EE_FEDERATION_MAX_REQUEST_BYTES,
  SafeFederationError,
  createSafeFederationRequester,
  isPublicFederationAddress,
} from './safe-federation-http';

interface TestServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

const openServers = new Set<TestServer>();

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<TestServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
  openServers.add(testServer);
  return testServer;
}

afterEach(async () => {
  await Promise.all([...openServers].map((server) => server.close()));
  openServers.clear();
});

function expectCode(code: SafeFederationError['code']): (error: unknown) => boolean {
  return (error) => error instanceof SafeFederationError && error.code === code;
}

describe('E2EE federation address policy', () => {
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '2001:4860:4860::8888',
    '2606:4700:4700::1111',
  ])('accepts a globally routable address: %s', (address) => {
    expect(isPublicFederationAddress(address)).toBe(true);
  });

  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.31.255.255',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '64:ff9b::7f00:1',
    '100::1',
    '2001:db8::1',
    '2002:7f00:1::',
    'fc00::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
    '4000::1',
    'not-an-ip',
  ])('rejects a non-public or special-purpose address: %s', (address) => {
    expect(isPublicFederationAddress(address)).toBe(false);
  });
});

describe('E2EE federation URL and DNS policy', () => {
  it('allows HTTPS public ICANN hostnames and resolves exactly once', async () => {
    const dnsResolver = vi.fn(async () => {
      throw new Error('deliberate DNS stop');
    });
    const request = createSafeFederationRequester({ dnsResolver, development: false });

    await expect(request('https://node.synapsis.social/api/e2ee/keys/alice')).rejects.toSatisfy(
      expectCode('DNS_RESOLUTION_FAILED')
    );
    expect(dnsResolver).toHaveBeenCalledOnce();
    expect(dnsResolver).toHaveBeenCalledWith('node.synapsis.social');
  });

  it.each([
    'http://node.synapsis.social/api/chat/receive',
    'http://localhost/api/chat/receive',
    'http://127.0.0.1/api/chat/receive',
    'http://[::1]/api/chat/receive',
    'https://8.8.8.8/api/chat/receive',
    'https://127.0.0.1/api/chat/receive',
    'https://[::1]/api/chat/receive',
    'https://localhost/api/chat/receive',
    'https://synapsis.test/api/chat/receive',
    'https://node.example/api/chat/receive',
    'https://example.com/api/chat/receive',
    'https://node.onion/api/chat/receive',
    'https://user:password@node.synapsis.social/api/chat/receive',
  ])('rejects a non-public federation target before DNS: %s', async (url) => {
    const dnsResolver = vi.fn(async () => [{ address: '8.8.8.8', family: 4 as const }]);
    const request = createSafeFederationRequester({ dnsResolver, development: false });

    await expect(request(url)).rejects.toSatisfy(expectCode('UNSAFE_URL'));
    expect(dnsResolver).not.toHaveBeenCalled();
  });

  it('rejects all resolved addresses when even one answer is unsafe', async () => {
    const request = createSafeFederationRequester({
      development: false,
      dnsResolver: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.7', family: 4 },
      ],
    });

    await expect(request('https://node.synapsis.social/api/chat/receive')).rejects.toSatisfy(
      expectCode('UNSAFE_DNS_RESULT')
    );
  });

  it('uses one validated DNS answer set and pins the selected address for the socket', async () => {
    const server = await startServer((_incoming, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"pinned":true}');
    });
    const dnsResolver = vi.fn(async () => [{ address: '127.0.0.1', family: 4 as const }]);
    const request = createSafeFederationRequester({ development: true, dnsResolver });
    const localhostUrl = server.baseUrl.replace('127.0.0.1', 'localhost');

    const response = await request(localhostUrl);

    expect(response.json()).toEqual({ pinned: true });
    expect(dnsResolver).toHaveBeenCalledOnce();
    expect(dnsResolver).toHaveBeenCalledWith('localhost');
  });

  it('applies the deadline while DNS resolution is still pending', async () => {
    const request = createSafeFederationRequester({
      development: false,
      dnsResolver: () => new Promise(() => undefined),
    });

    await expect(
      request('https://node.synapsis.social/api/chat/receive', { timeoutMs: 20 })
    ).rejects.toSatisfy(expectCode('TIMEOUT'));
  });

  it.each([
    'http://localhost:1/api/chat/receive',
    'http://127.0.0.1:1/api/chat/receive',
    'http://[::1]:1/api/chat/receive',
  ])('permits only exact HTTP loopback forms in development: %s', async (url) => {
    const request = createSafeFederationRequester({
      development: true,
      dnsResolver: async () => [{ address: '127.0.0.1', family: 4 }],
    });

    // Connection refusal confirms policy and pinning passed; unsafe URL/DNS errors do not.
    await expect(request(url, { timeoutMs: 100 })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof SafeFederationError &&
        (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT')
    );
  });

  it.each([
    'http://localhost.evil.com:3000/',
    'http://127.0.0.2:3000/',
    'http://2130706433:3000/',
    'http://[::ffff:127.0.0.1]:3000/',
    'https://localhost:3000/',
  ])('rejects lookalike or non-HTTP development targets: %s', async (url) => {
    const request = createSafeFederationRequester({ development: true });
    await expect(request(url)).rejects.toSatisfy(expectCode('UNSAFE_URL'));
  });
});

describe('E2EE federation HTTP behavior', () => {
  it('rejects an oversized request body before DNS or network activity', async () => {
    const dnsResolver = vi.fn(async () => [{ address: '8.8.8.8', family: 4 as const }]);
    const request = createSafeFederationRequester({ development: false, dnsResolver });

    await expect(request('https://node.synapsis.social/api/chat/receive', {
      method: 'POST',
      body: 'x'.repeat(E2EE_FEDERATION_MAX_REQUEST_BYTES + 1),
    })).rejects.toSatisfy(expectCode('REQUEST_TOO_LARGE'));
    expect(dnsResolver).not.toHaveBeenCalled();
  });

  it('supports GET, bounded buffering, UTF-8 text, and JSON parsing', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true, message: 'encrypted' }));
    });
    const request = createSafeFederationRequester({ development: true });

    const response = await request(`${server.baseUrl}/keys`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.text()).toBe('{"ok":true,"message":"encrypted"}');
    expect(response.json()).toEqual({ ok: true, message: 'encrypted' });
  });

  it('supports POST headers and a body while owning framing headers', async () => {
    const server = await startServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            method: incoming.method,
            signature: incoming.headers['x-synapsis-signature'],
            body: Buffer.concat(chunks).toString('utf8'),
            contentLength: incoming.headers['content-length'],
            acceptEncoding: incoming.headers['accept-encoding'],
          })
        );
      });
    });
    const request = createSafeFederationRequester({ development: true });
    const body = JSON.stringify({ ciphertext: 'abc123' });

    const response = await request(`${server.baseUrl}/receive`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-synapsis-signature': 'signed',
      },
      body,
    });

    expect(response.json()).toEqual({
      method: 'POST',
      signature: 'signed',
      body,
      contentLength: String(Buffer.byteLength(body)),
      acceptEncoding: 'identity',
    });
  });

  it('supports bounded DELETE requests without following redirects', async () => {
    const server = await startServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          method: incoming.method,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
    });
    const request = createSafeFederationRequester({ development: true });
    const body = JSON.stringify({ replyId: 'reply-1' });

    const response = await request(`${server.baseUrl}/replies`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body,
    });

    expect(response.json()).toEqual({ method: 'DELETE', body });
  });

  it('returns redirects without following them', async () => {
    let destinationHits = 0;
    const server = await startServer((incoming, response) => {
      if (incoming.url === '/destination') destinationHits += 1;
      response.writeHead(incoming.url === '/redirect' ? 302 : 200, {
        location: '/destination',
        'content-type': 'application/json',
      });
      response.end(JSON.stringify({ redirected: incoming.url !== '/redirect' }));
    });
    const request = createSafeFederationRequester({ development: true });

    const response = await request(`${server.baseUrl}/redirect`);

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/destination');
    expect(destinationHits).toBe(0);
  });

  it('rejects streamed responses that exceed the byte limit', async () => {
    const server = await startServer((_incoming, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"padding":"');
      response.end(`${'x'.repeat(128)}"}`);
    });
    const request = createSafeFederationRequester({ development: true });

    await expect(
      request(`${server.baseUrl}/large`, { maxResponseBytes: 32 })
    ).rejects.toSatisfy(expectCode('RESPONSE_TOO_LARGE'));
  });

  it('returns a bounded prefix only when truncation is explicitly requested', async () => {
    const server = await startServer((_incoming, response) => {
      const body = `<title>Preview</title>${'x'.repeat(4_096)}`;
      response.writeHead(200, {
        'content-type': 'text/html',
        'content-length': String(Buffer.byteLength(body)),
      });
      response.end(body);
    });
    const request = createSafeFederationRequester({ development: true });

    const response = await request(`${server.baseUrl}/large-page`, {
      maxResponseBytes: 64,
      truncateResponse: true,
    });

    expect(response.body.byteLength).toBe(64);
    expect(response.text()).toContain('<title>Preview</title>');
  });

  it('enforces one deadline across the request', async () => {
    const server = await startServer((_incoming, response) => {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"late":true}');
      }, 150);
    });
    const request = createSafeFederationRequester({ development: true });

    await expect(
      request(`${server.baseUrl}/slow`, { timeoutMs: 25 })
    ).rejects.toSatisfy(expectCode('TIMEOUT'));
  });

  it('rejects compressed, mislabeled, and malformed JSON responses', async () => {
    const server = await startServer((incoming, response) => {
      if (incoming.url === '/compressed') {
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
        });
        response.end('not actually compressed');
        return;
      }
      response.writeHead(200, {
        'content-type': incoming.url === '/text' ? 'text/plain' : 'application/json',
      });
      response.end(incoming.url === '/text' ? '{"valid":true}' : '{broken');
    });
    const request = createSafeFederationRequester({ development: true });

    await expect(request(`${server.baseUrl}/compressed`)).rejects.toSatisfy(
      expectCode('UNEXPECTED_CONTENT_ENCODING')
    );
    const textResponse = await request(`${server.baseUrl}/text`);
    expect(() => textResponse.json()).toThrowError(
      expect.objectContaining({ code: 'UNEXPECTED_CONTENT_TYPE' })
    );
    const malformedResponse = await request(`${server.baseUrl}/malformed`);
    expect(() => malformedResponse.json()).toThrowError(
      expect.objectContaining({ code: 'INVALID_JSON' })
    );
  });

  it('forbids caller-controlled routing and framing headers', async () => {
    const request = createSafeFederationRequester({ development: true });

    await expect(
      request('http://127.0.0.1:1/', { headers: { host: '169.254.169.254' } })
    ).rejects.toSatisfy(expectCode('INVALID_HEADER'));
    await expect(
      request('http://127.0.0.1:1/', { headers: { 'content-length': '999' } })
    ).rejects.toSatisfy(expectCode('INVALID_HEADER'));
    await expect(
      request('http://127.0.0.1:1/', { headers: { authorization: 'Bearer secret' } })
    ).rejects.toSatisfy(expectCode('INVALID_HEADER'));
    await expect(
      request('http://127.0.0.1:1/', { headers: { cookie: 'session=secret' } })
    ).rejects.toSatisfy(expectCode('INVALID_HEADER'));
  });
});
