import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { exchangeAuthorizationCode, StuffboxApiError } from '@/lib/stuffbox/client';
import { consumeStuffboxConnectionState } from '@/lib/stuffbox/connection-state';
import { saveStuffboxTokens } from '@/lib/stuffbox/tokens';
import { renderStuffboxPopupResponse } from '@/lib/stuffbox/popup-response';
import { getOrRefreshStuffboxBadge } from '@/lib/stuffbox/badge-status';

function popupResponse(origin: string, success: boolean, message: string, attemptId?: string): NextResponse {
  return new NextResponse(renderStuffboxPopupResponse(origin, success, message, attemptId), {
    status: success ? 200 : 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  let attemptId: string | undefined;
  try {
    const user = await requireAuth();
    const pending = await consumeStuffboxConnectionState();
    attemptId = pending?.state;
    const code = request.nextUrl.searchParams.get('code');
    const state = request.nextUrl.searchParams.get('state');
    const denied = request.nextUrl.searchParams.get('error');

    if (denied) return popupResponse(origin, false, 'Stuffbox access was not approved.', attemptId);
    if (!pending || pending.userId !== user.id || !code || state !== pending.state) {
      return popupResponse(origin, false, 'The Stuffbox connection request is invalid or expired.', attemptId);
    }

    const tokens = await exchangeAuthorizationCode(pending.baseUrl, {
      clientId: pending.clientId,
      code,
      codeVerifier: pending.verifier,
      redirectUri: pending.callbackUrl,
    });
    await saveStuffboxTokens(user.id, pending.baseUrl, tokens);
    await getOrRefreshStuffboxBadge(user, { force: true });
    return popupResponse(new URL(pending.callbackUrl).origin, true, 'Stuffbox connected.', attemptId);
  } catch (error) {
    if (error instanceof StuffboxApiError) {
      return popupResponse(origin, false, error.message, attemptId);
    }
    console.error('Stuffbox callback error:', error);
    return popupResponse(origin, false, 'Stuffbox could not be connected.', attemptId);
  }
}
