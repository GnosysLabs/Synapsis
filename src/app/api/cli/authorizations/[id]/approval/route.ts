import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, cliAuthorizationRequests, cliCredentials } from '@/db';
import { requireAuth } from '@/lib/auth';
import { requireSignedAction, SignedActionError, type SignedAction } from '@/lib/auth/verify-signature';
import { parseCliScopes } from '@/lib/cli/scopes';

type Context = { params: Promise<{ id: string }> };
const approvalSchema = z.object({ requestId: z.string().uuid() });

export async function GET(_request: Request, context: Context) {
  try {
    const user = await requireAuth();
    const { id } = await context.params;
    const authorization = await db.query.cliAuthorizationRequests.findFirst({ where: { id } });
    if (!authorization
      || (authorization.approvedByUserId && authorization.approvedByUserId !== user.id)) {
      return NextResponse.json({ error: 'Authorization request not found' }, { status: 404 });
    }

    return NextResponse.json({
      id: authorization.id,
      name: authorization.name,
      fingerprint: authorization.publicKeyFingerprint,
      scopes: parseCliScopes(authorization.scopes),
      credentialLifetimeDays: authorization.credentialLifetimeDays,
      status: authorization.expiresAt.getTime() <= Date.now() && authorization.status === 'pending'
        ? 'expired'
        : authorization.status,
      expiresAt: authorization.expiresAt.toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    console.error('CLI authorization details error:', error);
    return NextResponse.json({ error: 'Unable to load CLI authorization' }, { status: 500 });
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const signedAction = await request.json() as SignedAction<unknown>;
    const user = await requireSignedAction(signedAction, 'cli_authorize');
    const input = approvalSchema.parse(signedAction.data);
    if (input.requestId !== id) {
      return NextResponse.json({ error: 'Authorization request mismatch', code: 'INVALID_ACTION' }, { status: 400 });
    }
    if (user.isSuspended || user.isSilenced) {
      return NextResponse.json({ error: 'Account restricted', code: 'ACCOUNT_RESTRICTED' }, { status: 403 });
    }

    const authorization = await db.query.cliAuthorizationRequests.findFirst({ where: { id } });
    if (!authorization || authorization.expiresAt.getTime() <= Date.now()) {
      return NextResponse.json({ error: 'Authorization request expired', code: 'AUTHORIZATION_EXPIRED' }, { status: 410 });
    }
    if (authorization.status === 'approved' && authorization.approvedByUserId === user.id && authorization.credentialId) {
      return NextResponse.json({ success: true, credentialId: authorization.credentialId });
    }
    if (authorization.status !== 'pending') {
      return NextResponse.json({ error: 'Authorization request is no longer pending' }, { status: 409 });
    }

    const credential = await db.transaction(async (tx) => {
      const expiresAt = new Date(Date.now() + authorization.credentialLifetimeDays * 24 * 60 * 60 * 1000);
      const [created] = await tx.insert(cliCredentials).values({
        userId: user.id,
        name: authorization.name,
        publicKey: authorization.publicKey,
        publicKeyFingerprint: authorization.publicKeyFingerprint,
        scopes: authorization.scopes,
        expiresAt,
      }).returning();
      const updated = await tx.update(cliAuthorizationRequests)
        .set({
          status: 'approved',
          credentialId: created.id,
          approvedByUserId: user.id,
          approvedAt: new Date(),
        })
        .where(and(
          eq(cliAuthorizationRequests.id, authorization.id),
          eq(cliAuthorizationRequests.status, 'pending'),
        ))
        .returning({ id: cliAuthorizationRequests.id });
      if (updated.length !== 1) throw new Error('AUTHORIZATION_RACE');
      return created;
    });

    return NextResponse.json({ success: true, credentialId: credential.id });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid approval', details: error.issues }, { status: 400 });
    }
    if (error instanceof SignedActionError) {
      return NextResponse.json({ error: 'Approval signature rejected', code: error.code }, { status: 403 });
    }
    if (error instanceof Error && error.message === 'AUTHORIZATION_RACE') {
      return NextResponse.json({ error: 'Authorization was already handled' }, { status: 409 });
    }
    console.error('CLI authorization approval error:', error);
    return NextResponse.json({ error: 'Unable to approve CLI authorization' }, { status: 500 });
  }
}
