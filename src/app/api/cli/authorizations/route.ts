import { and, eq, lt } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, cliAuthorizationRequests } from '@/db';
import {
  CLI_AUTHORIZATION_POLL_INTERVAL_SECONDS,
  CLI_AUTHORIZATION_TTL_MS,
  CLI_CREDENTIAL_LIFETIME_DAYS_DEFAULT,
  CLI_CREDENTIAL_LIFETIME_DAYS_MAX,
  createCliDeviceCode,
  fingerprintCliPublicKey,
  hashCliDeviceCode,
  validateCliPublicKey,
} from '@/lib/cli/authorization';
import { CLI_SCOPES, serializeCliScopes } from '@/lib/cli/scopes';
import { isRateLimited } from '@/lib/rate-limit';

const requestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  publicKey: z.string().min(1).max(2048),
  scopes: z.array(z.enum(CLI_SCOPES)).min(1).max(CLI_SCOPES.length),
  credentialLifetimeDays: z.number().int().min(1).max(CLI_CREDENTIAL_LIFETIME_DAYS_MAX)
    .default(CLI_CREDENTIAL_LIFETIME_DAYS_DEFAULT),
});

export async function POST(request: Request) {
  try {
    const clientAddress = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || request.headers.get('x-real-ip')
      || 'unknown';
    if (isRateLimited(`cli-authorization:${clientAddress}`, 10, 10 * 60 * 1000)) {
      return NextResponse.json({ error: 'Too many authorization requests', code: 'RATE_LIMITED' }, { status: 429 });
    }

    const input = requestSchema.parse(await request.json());
    await validateCliPublicKey(input.publicKey);

    const now = new Date();
    await db.delete(cliAuthorizationRequests).where(and(
      eq(cliAuthorizationRequests.status, 'pending'),
      lt(cliAuthorizationRequests.expiresAt, now),
    ));

    const deviceCode = createCliDeviceCode();
    const expiresAt = new Date(now.getTime() + CLI_AUTHORIZATION_TTL_MS);
    const [authorization] = await db.insert(cliAuthorizationRequests).values({
      deviceCodeHash: hashCliDeviceCode(deviceCode),
      name: input.name,
      publicKey: input.publicKey,
      publicKeyFingerprint: fingerprintCliPublicKey(input.publicKey),
      scopes: serializeCliScopes(input.scopes),
      credentialLifetimeDays: input.credentialLifetimeDays,
      expiresAt,
    }).returning();

    const origin = new URL(request.url).origin;
    const verificationUri = new URL('/settings/cli', origin);
    const verificationUriComplete = new URL(verificationUri);
    verificationUriComplete.searchParams.set('request', authorization.id);

    return NextResponse.json({
      authorizationRequestId: authorization.id,
      deviceCode,
      verificationUri: verificationUri.toString(),
      verificationUriComplete: verificationUriComplete.toString(),
      expiresAt: expiresAt.toISOString(),
      interval: CLI_AUTHORIZATION_POLL_INTERVAL_SECONDS,
    }, {
      status: 201,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid authorization request', details: error.issues }, { status: 400 });
    }
    if (error instanceof Error && error.message === 'INVALID_PUBLIC_KEY') {
      return NextResponse.json({ error: 'The CLI supplied an invalid signing key', code: error.message }, { status: 400 });
    }
    console.error('CLI authorization request error:', error);
    return NextResponse.json({ error: 'Unable to start CLI authorization' }, { status: 500 });
  }
}
