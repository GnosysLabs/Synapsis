/**
 * Account NSFW Setting API
 * 
 * POST: Mark/unmark your account as NSFW (content creator setting)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, users } from '@/db';
import { eq } from 'drizzle-orm';
import { requireSignedAction, SignedActionError } from '@/lib/auth/verify-signature';
import { z } from 'zod';

const updateSchema = z.object({
  isNsfw: z.boolean(),
});

/**
 * POST /api/settings/account-nsfw
 * 
 * Mark your account as producing NSFW content.
 * All your posts will be treated as NSFW.
 */
export async function POST(request: NextRequest) {
  try {
    const signedAction = await request.json();
    if (signedAction.action !== 'update_account_nsfw') {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
    const user = await requireSignedAction(signedAction);
    const { isNsfw } = updateSchema.parse(signedAction.data);

    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 500 });
    }

    await db.update(users)
      .set({
        isNsfw,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    return NextResponse.json({
      success: true,
      isNsfw,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid input', details: error.issues }, { status: 400 });
    }
    if (error instanceof SignedActionError) {
      return NextResponse.json({ error: 'Your identity could not be verified. Please unlock it and try again.' }, { status: 403 });
    }
    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    console.error('Account NSFW settings update error:', error);
    return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 });
  }
}
