import { NextResponse } from 'next/server';
import { db } from '@/db';
import { hashCliDeviceCode } from '@/lib/cli/authorization';

type Context = { params: Promise<{ id: string }> };

function deviceCodeFrom(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : null;
}

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  const deviceCode = deviceCodeFrom(request);
  if (!deviceCode) {
    return NextResponse.json({ error: 'Device code required', code: 'DEVICE_CODE_REQUIRED' }, { status: 401 });
  }

  const authorization = await db.query.cliAuthorizationRequests.findFirst({
    where: { id },
    with: {
      credential: { with: { user: true } },
    },
  });
  if (!authorization || hashCliDeviceCode(deviceCode) !== authorization.deviceCodeHash) {
    return NextResponse.json({ error: 'Authorization request not found', code: 'AUTHORIZATION_NOT_FOUND' }, { status: 404 });
  }

  const headers = { 'Cache-Control': 'no-store' };
  if (authorization.expiresAt.getTime() <= Date.now() && authorization.status === 'pending') {
    return NextResponse.json({ status: 'expired' }, { status: 410, headers });
  }
  if (authorization.status !== 'approved' || !authorization.credential) {
    return NextResponse.json({ status: authorization.status }, { headers });
  }

  return NextResponse.json({
    status: 'approved',
    credential: {
      id: authorization.credential.id,
      name: authorization.credential.name,
      scopes: JSON.parse(authorization.credential.scopes),
      expiresAt: authorization.credential.expiresAt.toISOString(),
    },
    account: {
      did: authorization.credential.user.did,
      handle: authorization.credential.user.handle,
      displayName: authorization.credential.user.displayName,
    },
  }, { headers });
}
