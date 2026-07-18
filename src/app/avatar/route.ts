import { NextRequest } from 'next/server';
import { z } from 'zod';

import { isRateLimited } from '@/lib/rate-limit';
import { safeFederationRequest } from '@/lib/swarm/safe-federation-http';

const DICEBEAR_BASE_URL = 'https://api.dicebear.com/9.x/bottts-neutral/svg';
const MAX_AVATAR_BYTES = 128 * 1024;
const MAX_AVATAR_CACHE_ENTRIES = 256;
const MAX_CONCURRENT_UPSTREAM_REQUESTS = 8;
const MAX_UPSTREAM_REQUESTS_PER_MINUTE = 240;
const AVATAR_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

const seedSchema = z.string().trim().min(1).max(640);
const avatarCache = new Map<string, { svg: string; expiresAt: number }>();
const pendingAvatars = new Map<string, Promise<string>>();
let activeUpstreamRequests = 0;

const responseHeaders = {
  'Cache-Control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800',
  'Content-Disposition': 'inline; filename="avatar.svg"',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'Content-Type': 'image/svg+xml; charset=utf-8',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const;

function validateUpstreamSvg(svg: string): string {
  const trimmed = svg.trim();
  if (!trimmed.startsWith('<svg')
    || /<\s*(?:script|foreignObject|iframe|object|embed)\b/i.test(trimmed)
    || /\bon[a-z]+\s*=/i.test(trimmed)
    || /\b(?:href|xlink:href)\s*=\s*["']\s*(?:javascript:|https?:|\/\/|data:text\/html)/i.test(trimmed)) {
    throw new Error('DiceBear returned an unsafe SVG');
  }
  return trimmed;
}

async function fetchAvatar(seed: string): Promise<string> {
  const cached = avatarCache.get(seed);
  if (cached && cached.expiresAt > Date.now()) {
    avatarCache.delete(seed);
    avatarCache.set(seed, cached);
    return cached.svg;
  }
  if (cached) avatarCache.delete(seed);

  const pending = pendingAvatars.get(seed);
  if (pending) return pending;
  if (activeUpstreamRequests >= MAX_CONCURRENT_UPSTREAM_REQUESTS
    || isRateLimited(
      'dicebear-avatar-upstream-global',
      MAX_UPSTREAM_REQUESTS_PER_MINUTE,
      60_000,
    )) {
    throw new Error('Avatar service is busy');
  }

  const request = (async () => {
    activeUpstreamRequests += 1;
    try {
      const url = new URL(DICEBEAR_BASE_URL);
      url.searchParams.set('seed', seed);
      const response = await safeFederationRequest(url.toString(), {
        headers: {
          Accept: 'image/svg+xml',
          'User-Agent': 'Synapsis Avatar Proxy/1.0',
        },
        timeoutMs: 5_000,
        maxResponseBytes: MAX_AVATAR_BYTES,
      });
      const contentType = response.headers['content-type'];
      const normalizedContentType = Array.isArray(contentType) ? contentType[0] : contentType;
      if (response.status < 200 || response.status >= 300
        || !normalizedContentType?.toLowerCase().startsWith('image/svg+xml')) {
        throw new Error('DiceBear avatar request failed');
      }
      const svg = validateUpstreamSvg(response.text());
      if (!avatarCache.has(seed) && avatarCache.size >= MAX_AVATAR_CACHE_ENTRIES) {
        const oldest = avatarCache.keys().next().value as string | undefined;
        if (oldest) avatarCache.delete(oldest);
      }
      avatarCache.set(seed, { svg, expiresAt: Date.now() + AVATAR_CACHE_TTL_MS });
      return svg;
    } finally {
      activeUpstreamRequests -= 1;
    }
  })();
  pendingAvatars.set(seed, request);
  try {
    return await request;
  } finally {
    pendingAvatars.delete(seed);
  }
}

export async function GET(request: NextRequest) {
  const parsedSeed = seedSchema.safeParse(request.nextUrl.searchParams.get('seed'));
  if (!parsedSeed.success) {
    return Response.json({ error: 'Invalid avatar seed' }, { status: 400 });
  }

  try {
    return new Response(await fetchAvatar(parsedSeed.data), {
      status: 200,
      headers: responseHeaders,
    });
  } catch (error) {
    console.warn('[Avatar] Could not load DiceBear avatar:', error);
    return Response.json({ error: 'Avatar unavailable' }, {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
