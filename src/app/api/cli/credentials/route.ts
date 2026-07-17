import { NextResponse } from 'next/server';
import { db } from '@/db';
import { requireAuth } from '@/lib/auth';
import { parseCliScopes } from '@/lib/cli/scopes';

export async function GET() {
  try {
    const user = await requireAuth();
    const credentials = await db.query.cliCredentials.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json({
      credentials: credentials.map(credential => ({
        id: credential.id,
        name: credential.name,
        fingerprint: credential.publicKeyFingerprint,
        scopes: parseCliScopes(credential.scopes),
        expiresAt: credential.expiresAt.toISOString(),
        lastUsedAt: credential.lastUsedAt?.toISOString() ?? null,
        revokedAt: credential.revokedAt?.toISOString() ?? null,
        createdAt: credential.createdAt.toISOString(),
      })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    console.error('CLI credential list error:', error);
    return NextResponse.json({ error: 'Unable to load CLI credentials' }, { status: 500 });
  }
}
