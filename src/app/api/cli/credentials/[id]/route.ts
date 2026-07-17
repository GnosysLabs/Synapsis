import { and, eq, isNull } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, cliCredentials } from '@/db';
import { requireSignedAction, SignedActionError, type SignedAction } from '@/lib/auth/verify-signature';

type Context = { params: Promise<{ id: string }> };
const revokeSchema = z.object({ credentialId: z.string().uuid() });

export async function DELETE(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const signedAction = await request.json() as SignedAction<unknown>;
    const user = await requireSignedAction(signedAction, 'cli_revoke');
    const input = revokeSchema.parse(signedAction.data);
    if (input.credentialId !== id) {
      return NextResponse.json({ error: 'Credential mismatch', code: 'INVALID_ACTION' }, { status: 400 });
    }

    const revoked = await db.update(cliCredentials)
      .set({ revokedAt: new Date() })
      .where(and(
        eq(cliCredentials.id, id),
        eq(cliCredentials.userId, user.id),
        isNull(cliCredentials.revokedAt),
      ))
      .returning({ id: cliCredentials.id });
    if (revoked.length === 0) {
      return NextResponse.json({ error: 'Credential not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid revocation' }, { status: 400 });
    }
    if (error instanceof SignedActionError) {
      return NextResponse.json({ error: 'Revocation signature rejected', code: error.code }, { status: 403 });
    }
    console.error('CLI credential revocation error:', error);
    return NextResponse.json({ error: 'Unable to revoke CLI credential' }, { status: 500 });
  }
}
