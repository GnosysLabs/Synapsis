import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { exchangeAuthorizationCode, StuffboxApiError } from '@/lib/stuffbox/client';
import { consumeStuffboxConnectionState } from '@/lib/stuffbox/connection-state';
import { saveStuffboxTokens } from '@/lib/stuffbox/tokens';
import { renderStuffboxPopupResponse } from '@/lib/stuffbox/popup-response';

function popupResponse(origin: string, success: boolean, message: string): NextResponse {
  return new NextResponse(renderStuffboxPopupResponse(origin, success, message), {
    status: success ? 200 : 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  try {
    const user = await requireAuth();
    const pending = await consumeStuffboxConnectionState();
    const code = request.nextUrl.searchParams.get('code');
    const state = request.nextUrl.searchParams.get('state');
    const denied = request.nextUrl.searchParams.get('error');

    if (denied) return popupResponse(origin, false, 'Stuffbox access was not approved.');
    if (!pending || pending.userId !== user.id || !code || state !== pending.state) {
      return popupResponse(origin, false, 'The Stuffbox connection request is invalid or expired.');
    }

    const tokens = await exchangeAuthorizationCode(pending.baseUrl, {
      code,
      codeVerifier: pending.verifier,
      redirectUri: pending.redirectUri,
    });
    await saveStuffboxTokens(user.id, pending.baseUrl, tokens);
    return popupResponse(new URL(pending.redirectUri).origin, true, 'Stuffbox connected.');
  } catch (error) {
    if (error instanceof StuffboxApiError) {
      return popupResponse(origin, false, error.message);
    }
    console.error('Stuffbox callback error:', error);
    return popupResponse(origin, false, 'Stuffbox could not be connected.');
  }
}
