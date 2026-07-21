import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { configuredStuffboxUrl, createConnectionRequest, StuffboxApiError } from '@/lib/stuffbox/client';
import { saveStuffboxConnectionState } from '@/lib/stuffbox/connection-state';
import { generatePkce } from '@/lib/stuffbox/crypto';
import { STUFFBOX_SCOPES } from '@/lib/stuffbox/types';
import { resolveAccountAddress } from '@/lib/identity/account-address';

function nodeOrigin(request: NextRequest): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (appUrl) return new URL(appUrl).origin;
  const configured = process.env.NEXT_PUBLIC_NODE_DOMAIN?.trim();
  if (!configured) return request.nextUrl.origin;
  const protocol = /^(localhost|127\.0\.0\.1)(:|$)/.test(configured) ? 'http' : 'https';
  return new URL(configured.includes('://') ? configured : `${protocol}://${configured}`).origin;
}

function accountLabel(handle: string, origin: string): string {
  const address = resolveAccountAddress(handle, new URL(origin).host);
  if (!address) throw new Error('Account identity is not canonical');
  return `@${address.canonical}`;
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth();
    const baseUrl = configuredStuffboxUrl();
    if (!baseUrl) {
      return NextResponse.json({
        error: 'Stuffbox is not configured on this node.',
        code: 'STUFFBOX_UNAVAILABLE',
      }, { status: 503 });
    }

    const origin = nodeOrigin(request);
    const callbackUrl = `${origin}/api/storage/stuffbox/callback`;
    const pkce = generatePkce();
    const connection = await createConnectionRequest(baseUrl, {
      callbackUrl,
      codeChallenge: pkce.challenge,
      state: pkce.state,
      scopes: STUFFBOX_SCOPES,
      accountLabel: accountLabel(user.handle, origin),
    });

    await saveStuffboxConnectionState({
      userId: user.id,
      baseUrl,
      clientId: connection.clientId,
      verifier: pkce.verifier,
      state: pkce.state,
      callbackUrl: connection.callbackUrl,
      expiresAt: Math.min(Date.parse(connection.expiresAt) || Date.now() + 10 * 60_000, Date.now() + 10 * 60_000),
    });

    return NextResponse.json({
      authorizationUrl: connection.authorizationUrl,
      connectionStartedAt: new Date().toISOString(),
      connectionAttempt: pkce.state,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    if (error instanceof StuffboxApiError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status || 502 });
    }
    console.error('Stuffbox connection error:', error);
    return NextResponse.json({ error: 'Unable to start Stuffbox connection' }, { status: 500 });
  }
}
