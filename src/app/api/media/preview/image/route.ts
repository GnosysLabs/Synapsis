import { NextRequest, NextResponse } from 'next/server';
import { isRateLimited } from '@/lib/rate-limit';
import { safeFederationRequest } from '@/lib/swarm/safe-federation-http';
import { federationWebUrlSchema } from '@/lib/utils/federation';

const MAX_PREVIEW_IMAGE_BYTES = 1024 * 1024;
const SAFE_IMAGE_CONTENT_TYPE = /^image\/(?:avif|gif|jpeg|png|webp)(?:\s*;|$)/i;

export async function GET(request: NextRequest) {
  const rawUrl = request.nextUrl.searchParams.get('url');
  const parsed = federationWebUrlSchema.safeParse(rawUrl);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid preview image URL' }, { status: 400 });
  }

  const target = new URL(parsed.data);
  const clientAddress = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')?.trim()
    || 'unknown';
  if (isRateLimited(`preview-image-client:${clientAddress}`, 180, 60 * 1_000)
    || isRateLimited(`preview-image-target:${target.hostname}`, 240, 60 * 1_000)
    || isRateLimited('preview-image-global', 1_200, 60 * 1_000)) {
    return NextResponse.json({ error: 'Too many preview image requests' }, { status: 429 });
  }

  try {
    const response = await safeFederationRequest(target.toString(), {
      headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif' },
      timeoutMs: 8_000,
      maxResponseBytes: MAX_PREVIEW_IMAGE_BYTES,
    });
    const header = response.headers['content-type'];
    const contentType = Array.isArray(header) ? header[0] : header;
    if (response.status < 200
      || response.status >= 300
      || !contentType
      || !SAFE_IMAGE_CONTENT_TYPE.test(contentType)) {
      return NextResponse.json({ error: 'Preview image is unavailable' }, { status: 404 });
    }

    return new NextResponse(new Uint8Array(response.body), {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Preview image is unavailable' }, { status: 404 });
  }
}
