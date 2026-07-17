import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db, cliCredentials } from '@/db';
import {
  isCliSignedAction,
  requireCliSignedAction,
  signedActionErrorStatus,
} from '@/lib/auth/cli-credentials';
import { SignedActionError } from '@/lib/auth/verify-signature';

export async function POST(request: Request) {
  try {
    const signedAction: unknown = await request.json();
    if (!isCliSignedAction(signedAction)) {
      return NextResponse.json({ error: 'Signed CLI action required' }, { status: 400 });
    }
    const { credential } = await requireCliSignedAction(signedAction, 'cli_revoke_self');
    await db.update(cliCredentials)
      .set({ revokedAt: new Date() })
      .where(eq(cliCredentials.id, credential.id));
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof SignedActionError) {
      return NextResponse.json({ error: 'Credential revocation rejected', code: error.code }, {
        status: signedActionErrorStatus(error),
      });
    }
    console.error('CLI self-revocation error:', error);
    return NextResponse.json({ error: 'Unable to revoke CLI credential' }, { status: 500 });
  }
}
