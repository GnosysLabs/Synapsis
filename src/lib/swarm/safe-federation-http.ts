import { lookup as nodeLookup } from 'node:dns/promises';
import {
  request as httpRequest,
  validateHeaderName,
  validateHeaderValue,
  type IncomingHttpHeaders,
  type RequestOptions,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { parse as parseDomain } from 'tldts';

export const E2EE_FEDERATION_TIMEOUT_MS = 8_000;
export const E2EE_FEDERATION_MAX_RESPONSE_BYTES = 256 * 1024;
export const E2EE_FEDERATION_MAX_REQUEST_BYTES = 1024 * 1024;

const MAX_CONFIGURABLE_RESPONSE_BYTES = 1024 * 1024;
const JSON_CONTENT_TYPE = /^(?:application\/json|[^/\s]+\/[^;\s]+\+json)(?:\s*;|$)/i;
const EXACT_DEVELOPMENT_LOOPBACK_URL =
  /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i;
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'accept-encoding',
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'expect',
  'host',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export type SafeFederationErrorCode =
  | 'ABORTED'
  | 'DNS_RESOLUTION_FAILED'
  | 'INVALID_HEADER'
  | 'INVALID_JSON'
  | 'INVALID_OPTION'
  | 'INVALID_URL'
  | 'NETWORK_ERROR'
  | 'REQUEST_TOO_LARGE'
  | 'RESPONSE_TOO_LARGE'
  | 'TIMEOUT'
  | 'UNEXPECTED_CONTENT_ENCODING'
  | 'UNEXPECTED_CONTENT_TYPE'
  | 'UNSAFE_DNS_RESULT'
  | 'UNSAFE_URL';

export class SafeFederationError extends Error {
  readonly code: SafeFederationErrorCode;
  override readonly cause?: unknown;

  constructor(code: SafeFederationErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'SafeFederationError';
    this.code = code;
    this.cause = cause;
  }
}

export type FederationRequestHeaders = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

export interface SafeFederationRequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  headers?: FederationRequestHeaders;
  body?: string | Uint8Array;
  /** May only shorten, never extend, the eight-second safety timeout. */
  timeoutMs?: number;
  /** May only lower the one-MiB hard response ceiling. */
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

export interface SafeFederationResponse {
  readonly url: string;
  readonly status: number;
  readonly headers: Readonly<IncomingHttpHeaders>;
  readonly body: Buffer;
  text(): string;
  json(): unknown;
}

export interface FederationDnsAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type FederationDnsResolver = (
  hostname: string
) => Promise<readonly FederationDnsAddress[]>;

export interface SafeFederationRequesterDependencies {
  /** Dependency seams are intended for focused tests, not request-specific policy. */
  readonly dnsResolver?: FederationDnsResolver;
  readonly development?: boolean;
}

interface ValidatedFederationTarget {
  readonly url: URL;
  readonly hostname: string;
  readonly loopbackDevelopmentTarget: boolean;
}

interface PinnedFederationTarget extends ValidatedFederationTarget {
  readonly address: string;
  readonly family: 4 | 6;
  readonly lookup: LookupFunction;
}

function invalidOption(message: string): never {
  throw new SafeFederationError('INVALID_OPTION', message);
}

function unwrapUrlHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function isExactLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1';
}

function parseIpv4(address: string): number[] | null {
  if (isIP(address) !== 4) return null;

  const octets = address.split('.').map(Number);
  return octets.length === 4 && octets.every((octet) => octet >= 0 && octet <= 255)
    ? octets
    : null;
}

function isPublicIpv4Address(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) return false;

  const [first, second, third] = octets;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function expandIpv6(address: string): number[] | null {
  let normalized = address.toLowerCase();
  const zoneIndex = normalized.indexOf('%');
  if (zoneIndex !== -1) return null;

  const ipv4TailMatch = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4TailMatch) {
    const octets = parseIpv4(ipv4TailMatch[1]);
    if (!octets) return null;
    normalized = `${normalized.slice(0, -ipv4TailMatch[1].length)}${(
      (octets[0] << 8) |
      octets[1]
    ).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  if (isIP(normalized) !== 6) return null;

  const doubleColonParts = normalized.split('::');
  if (doubleColonParts.length > 2) return null;

  const left = doubleColonParts[0] ? doubleColonParts[0].split(':') : [];
  const right = doubleColonParts[1] ? doubleColonParts[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (doubleColonParts.length === 1 && missing !== 0)) return null;

  const parts = [
    ...left,
    ...Array.from({ length: missing }, () => '0'),
    ...right,
  ].map((part) => Number.parseInt(part || '0', 16));

  return parts.length === 8 && parts.every((part) => Number.isInteger(part) && part <= 0xffff)
    ? parts
    : null;
}

function hasIpv6Prefix(parts: readonly number[], prefix: readonly number[], bits: number): boolean {
  let remaining = bits;

  for (let index = 0; remaining > 0; index += 1) {
    const comparedBits = Math.min(remaining, 16);
    const mask = comparedBits === 16 ? 0xffff : (0xffff << (16 - comparedBits)) & 0xffff;
    if ((parts[index] & mask) !== ((prefix[index] ?? 0) & mask)) return false;
    remaining -= comparedBits;
  }

  return true;
}

function isPublicIpv6Address(address: string): boolean {
  const parts = expandIpv6(address);
  if (!parts) return false;

  // Ordinary globally routed IPv6 unicast space is currently 2000::/3.
  // Requiring that allocation also rejects unassigned/reserved top-level space.
  if (!hasIpv6Prefix(parts, [0x2000], 3)) return false;

  const specialPrefixes: ReadonlyArray<readonly [readonly number[], number]> = [
    [[0x0000], 96], // unspecified, loopback, and IPv4-compatible
    [[0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0xffff], 96], // IPv4-mapped
    [[0x0064, 0xff9b], 96], // well-known NAT64 translation prefix
    [[0x0064, 0xff9b, 0x0001], 48], // local-use NAT64 translation prefix
    [[0x0100], 64], // discard-only
    [[0x2001, 0x0000], 32], // Teredo
    [[0x2001, 0x0002], 48], // benchmarking
    [[0x2001, 0x0db8], 32], // documentation (2001:db8::/32)
    [[0x2001, 0x0010], 28], // deprecated ORCHID
    [[0x2001, 0x0020], 28], // ORCHIDv2
    [[0x2001, 0x0030], 28], // Drone Remote ID protocol assignments
    [[0x2002], 16], // 6to4
    [[0x3fff], 20], // documentation
    [[0x5f00], 16], // segment-routing SIDs
    [[0xfc00], 7], // unique-local
    [[0xfe80], 10], // link-local
    [[0xfec0], 10], // deprecated site-local
    [[0xff00], 8], // multicast
  ];

  return !specialPrefixes.some(([prefix, bits]) => hasIpv6Prefix(parts, prefix, bits));
}

/** True only for ordinary globally routable IPv4/IPv6 addresses. */
export function isPublicFederationAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4Address(address);
  if (family === 6) return isPublicIpv6Address(address);
  return false;
}

function validateFederationUrl(
  input: string,
  development: boolean
): ValidatedFederationTarget {
  const trimmed = input.trim();
  let url: URL;

  try {
    url = new URL(trimmed);
  } catch (error) {
    throw new SafeFederationError('INVALID_URL', 'Federation target is not a valid URL', error);
  }

  if (url.username || url.password) {
    throw new SafeFederationError('UNSAFE_URL', 'Federation URLs cannot contain credentials');
  }

  const hostname = unwrapUrlHostname(url.hostname).toLowerCase();
  const exactDevelopmentLoopback =
    development &&
    url.protocol === 'http:' &&
    EXACT_DEVELOPMENT_LOOPBACK_URL.test(trimmed) &&
    (hostname === 'localhost' || isExactLoopbackAddress(hostname));

  if (exactDevelopmentLoopback) {
    return { url, hostname, loopbackDevelopmentTarget: true };
  }

  if (url.protocol !== 'https:') {
    throw new SafeFederationError(
      'UNSAFE_URL',
      'Federation targets must use HTTPS (except exact loopback hosts in development)'
    );
  }

  if (isIP(hostname) !== 0) {
    throw new SafeFederationError('UNSAFE_URL', 'Federation targets must use a public hostname');
  }

  const parsed = parseDomain(hostname, {
    allowPrivateDomains: false,
    detectSpecialUse: true,
  });
  if (!parsed.domain || parsed.isIcann !== true || parsed.isIp || parsed.isSpecialUse) {
    throw new SafeFederationError('UNSAFE_URL', 'Federation target is not a public ICANN hostname');
  }

  return { url, hostname, loopbackDevelopmentTarget: false };
}

function createPinnedLookup(
  expectedHostname: string,
  address: string,
  family: 4 | 6
): LookupFunction {
  return ((
    requestedHostname: string,
    options: number | { all?: boolean },
    callback: (
      error: NodeJS.ErrnoException | null,
      addressOrAddresses: string | FederationDnsAddress[],
      resultFamily?: number
    ) => void
  ) => {
    if (requestedHostname.toLowerCase() !== expectedHostname) {
      const error = new Error('Unexpected hostname passed to pinned DNS lookup') as NodeJS.ErrnoException;
      error.code = 'ENOTFOUND';
      callback(error, '', 0);
      return;
    }

    if (typeof options === 'object' && options.all) {
      callback(null, [{ address, family }]);
      return;
    }

    callback(null, address, family);
  }) as LookupFunction;
}

const defaultDnsResolver: FederationDnsResolver = async (hostname) => {
  const addresses = await nodeLookup(hostname, { all: true, verbatim: true });
  return addresses.filter(
    (address): address is FederationDnsAddress => address.family === 4 || address.family === 6
  );
};

async function resolveAndPinTarget(
  target: ValidatedFederationTarget,
  resolver: FederationDnsResolver
): Promise<PinnedFederationTarget> {
  let addresses: readonly FederationDnsAddress[];

  if (target.hostname === '127.0.0.1') {
    addresses = [{ address: '127.0.0.1', family: 4 }];
  } else if (target.hostname === '::1') {
    addresses = [{ address: '::1', family: 6 }];
  } else {
    try {
      addresses = await resolver(target.hostname);
    } catch (error) {
      throw new SafeFederationError(
        'DNS_RESOLUTION_FAILED',
        'Federation target DNS resolution failed',
        error
      );
    }
  }

  if (addresses.length === 0) {
    throw new SafeFederationError(
      'DNS_RESOLUTION_FAILED',
      'Federation target DNS resolution returned no addresses'
    );
  }

  const allAddressesAllowed = addresses.every(({ address, family }) => {
    if (isIP(address) !== family) return false;
    return target.loopbackDevelopmentTarget
      ? isExactLoopbackAddress(address)
      : isPublicFederationAddress(address);
  });
  if (!allAddressesAllowed) {
    throw new SafeFederationError(
      'UNSAFE_DNS_RESULT',
      'Federation target DNS resolution included an unsafe address'
    );
  }

  const pinned = addresses[0];
  return {
    ...target,
    address: pinned.address,
    family: pinned.family,
    lookup: createPinnedLookup(target.hostname, pinned.address, pinned.family),
  };
}

function validatePositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    return invalidOption(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

function normalizeHeaders(
  input: FederationRequestHeaders | undefined,
  body: Buffer | undefined
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {
    accept: 'application/json',
    'accept-encoding': 'identity',
  };

  for (const [rawName, rawValue] of Object.entries(input ?? {})) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    if (FORBIDDEN_REQUEST_HEADERS.has(name)) {
      throw new SafeFederationError('INVALID_HEADER', `Request header ${rawName} is not allowed`);
    }

    try {
      validateHeaderName(name);
      if (Array.isArray(rawValue)) {
        rawValue.forEach((value) => validateHeaderValue(name, value));
      } else {
        validateHeaderValue(name, rawValue as string);
      }
    } catch (error) {
      throw new SafeFederationError('INVALID_HEADER', `Request header ${rawName} is invalid`, error);
    }
    headers[name] = Array.isArray(rawValue) ? [...rawValue] : (rawValue as string);
  }

  if (body) headers['content-length'] = String(body.byteLength);
  return headers;
}

function createResponse(
  url: string,
  status: number,
  incomingHeaders: IncomingHttpHeaders,
  body: Buffer
): SafeFederationResponse {
  const headers = Object.freeze(
    Object.fromEntries(
      Object.entries(incomingHeaders).map(([name, value]) => [
        name,
        Array.isArray(value) ? Object.freeze([...value]) : value,
      ])
    ) as IncomingHttpHeaders
  );
  const storedBody = Buffer.from(body);
  const exposedBody = Buffer.from(storedBody);

  return Object.freeze({
    url,
    status,
    headers,
    body: exposedBody,
    text(): string {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(storedBody);
      } catch (error) {
        throw new SafeFederationError('INVALID_JSON', 'Response body is not valid UTF-8', error);
      }
    },
    json(): unknown {
      const contentType = headers['content-type'];
      const normalizedContentType = Array.isArray(contentType) ? contentType[0] : contentType;
      if (!normalizedContentType || !JSON_CONTENT_TYPE.test(normalizedContentType)) {
        throw new SafeFederationError(
          'UNEXPECTED_CONTENT_TYPE',
          'Response does not declare a JSON content type'
        );
      }

      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(storedBody);
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        return JSON.parse(text) as unknown;
      } catch (error) {
        throw new SafeFederationError('INVALID_JSON', 'Response body is not valid JSON', error);
      }
    },
  });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function requestPinnedTarget(
  target: PinnedFederationTarget,
  method: 'GET' | 'POST' | 'DELETE',
  headers: Record<string, string | string[]>,
  body: Buffer | undefined,
  maxResponseBytes: number,
  signal: AbortSignal
): Promise<SafeFederationResponse> {
  return new Promise((resolve, reject) => {
    const requestOptions: RequestOptions = {
      protocol: target.url.protocol,
      hostname: target.hostname,
      port: target.url.port || undefined,
      method,
      path: `${target.url.pathname}${target.url.search}`,
      headers,
      lookup: target.lookup,
      agent: false,
      maxHeaderSize: 16 * 1024,
      signal,
    };

    const makeRequest = target.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = makeRequest(requestOptions, (response) => {
      const contentEncoding = response.headers['content-encoding'];
      if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') {
        response.destroy();
        reject(
          new SafeFederationError(
            'UNEXPECTED_CONTENT_ENCODING',
            'Compressed federation responses are not accepted'
          )
        );
        return;
      }

      const declaredLength = Number(response.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
        response.destroy();
        reject(
          new SafeFederationError(
            'RESPONSE_TOO_LARGE',
            `Federation response exceeds the ${maxResponseBytes}-byte limit`
          )
        );
        return;
      }

      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += buffer.byteLength;
        if (receivedBytes > maxResponseBytes) {
          response.destroy();
          reject(
            new SafeFederationError(
              'RESPONSE_TOO_LARGE',
              `Federation response exceeds the ${maxResponseBytes}-byte limit`
            )
          );
          return;
        }
        chunks.push(buffer);
      });
      response.once('end', () => {
        resolve(
          createResponse(
            target.url.toString(),
            response.statusCode ?? 0,
            response.headers,
            Buffer.concat(chunks, receivedBytes)
          )
        );
      });
      response.once('error', reject);
    });

    request.once('error', (error) => reject(error));
    if (body) request.write(body);
    request.end();
  });
}

/**
 * Build the E2EE federation requester. The default export below is locked to
 * runtime environment policy; the factory's seams exist for deterministic tests.
 */
export function createSafeFederationRequester(
  dependencies: SafeFederationRequesterDependencies = {}
): (url: string, options?: SafeFederationRequestOptions) => Promise<SafeFederationResponse> {
  const resolver = dependencies.dnsResolver ?? defaultDnsResolver;
  const development = dependencies.development ?? process.env.NODE_ENV === 'development';

  return async (url, options = {}) => {
    const method = options.method ?? 'GET';
    if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
      return invalidOption('Federation requests only support GET, POST, and DELETE');
    }

    if (method === 'GET' && options.body !== undefined) {
      return invalidOption('GET federation requests cannot contain a body');
    }

    const timeoutMs = validatePositiveInteger(
      options.timeoutMs,
      E2EE_FEDERATION_TIMEOUT_MS,
      E2EE_FEDERATION_TIMEOUT_MS,
      'timeoutMs'
    );
    const maxResponseBytes = validatePositiveInteger(
      options.maxResponseBytes,
      E2EE_FEDERATION_MAX_RESPONSE_BYTES,
      MAX_CONFIGURABLE_RESPONSE_BYTES,
      'maxResponseBytes'
    );

    const body =
      options.body === undefined
        ? undefined
        : typeof options.body === 'string'
          ? Buffer.from(options.body, 'utf8')
          : Buffer.from(options.body);
    if (body && body.byteLength > E2EE_FEDERATION_MAX_REQUEST_BYTES) {
      throw new SafeFederationError(
        'REQUEST_TOO_LARGE',
        `Federation request exceeds the ${E2EE_FEDERATION_MAX_REQUEST_BYTES}-byte limit`
      );
    }

    const headers = normalizeHeaders(options.headers, body);
    const target = validateFederationUrl(url, development);
    const controller = new AbortController();
    const timeoutError = new SafeFederationError(
      'TIMEOUT',
      `Federation request exceeded ${timeoutMs}ms`
    );
    const timeout = setTimeout(() => controller.abort(timeoutError), timeoutMs);
    timeout.unref?.();

    const onExternalAbort = () =>
      controller.abort(new SafeFederationError('ABORTED', 'Federation request was aborted'));
    if (options.signal?.aborted) onExternalAbort();
    else options.signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const pinned = await abortable(resolveAndPinTarget(target, resolver), controller.signal);
      return await requestPinnedTarget(
        pinned,
        method,
        headers,
        body,
        maxResponseBytes,
        controller.signal
      );
    } catch (error) {
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof SafeFederationError
          ? controller.signal.reason
          : new SafeFederationError('ABORTED', 'Federation request was aborted', error);
      }
      if (error instanceof SafeFederationError) throw error;
      throw new SafeFederationError('NETWORK_ERROR', 'Federation request failed', error);
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  };
}

export const safeFederationRequest = createSafeFederationRequester();
