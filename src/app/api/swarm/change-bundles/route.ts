import { NextResponse } from 'next/server';
import { isRateLimited } from '@/lib/rate-limit';
import { getCachedVerifiedChangeBundle } from '@/lib/swarm/change-bundle';
import { getPublicSwarmDomain, isPublicSwarmDomain } from '@/lib/swarm/node-domain';
import { getTrustedFederationReadSource } from '@/lib/swarm/signed-read';

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' };

/** Serve only origin-signed pages; this relay has no authority to alter them. */
export async function GET(request: Request) {
  try {
    if (isRateLimited('change-bundle-read-preauth-global', 6_000, 60_000)) {
      return NextResponse.json(
        { error: 'Change bundle relay overloaded' },
        { status: 429, headers: NO_STORE_HEADERS },
      );
    }
    const source = await getTrustedFederationReadSource(request);
    if (!source) {
      return NextResponse.json(
        { error: 'Authenticated federation read required' },
        { status: 401, headers: NO_STORE_HEADERS },
      );
    }
    if (isRateLimited('change-bundle-read-authenticated-global', 6_000, 60_000)
      || isRateLimited(`change-bundle-read-node:${source}`, 120, 60_000)) {
      return NextResponse.json(
        { error: 'Too many change bundle reads' },
        { status: 429, headers: NO_STORE_HEADERS },
      );
    }

    const url = new URL(request.url);
    const origin = getPublicSwarmDomain(url.searchParams.get('origin'));
    const after = Number(url.searchParams.get('after'));
    if (!origin || !isPublicSwarmDomain(origin)
      || !Number.isSafeInteger(after) || after < 0) {
      return NextResponse.json(
        { error: 'Invalid change bundle query' },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    const verified = await getCachedVerifiedChangeBundle(origin, after);
    if (!verified) {
      return NextResponse.json(
        { error: 'No cached change bundle covers this cursor' },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(verified.signed, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error('[ChangeBundle] Relay route error:', error);
    return NextResponse.json(
      { error: 'Failed to read cached change bundle' },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
