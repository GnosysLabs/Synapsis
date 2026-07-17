/**
 * NSFW Settings API
 * 
 * GET: Get current user's NSFW settings
 * POST: Update NSFW settings (requires age verification for enabling)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, users } from '@/db';
import { eq } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth'; // kept for GET
import { requireSignedAction, SignedActionError } from '@/lib/auth/verify-signature';
import { z } from 'zod';
import { isLocalNodeNsfw } from '@/lib/node/local-node';

const updateSchema = z.object({
  nsfwEnabled: z.boolean(),
  confirmAge: z.boolean().optional(), // Must be true when enabling NSFW
});

/**
 * GET /api/settings/nsfw
 * 
 * Returns current user's NSFW settings
 */
export async function GET() {
  try {
    const user = await requireAuth();
    const localNodeIsNsfw = await isLocalNodeNsfw();

    return NextResponse.json({
      nsfwEnabled: localNodeIsNsfw
        ? Boolean(user.ageVerifiedAt)
        : user.nsfwEnabled,
      ageVerifiedAt: user.ageVerifiedAt?.toISOString() || null,
      isNsfw: user.isNsfw, // Whether their account is marked NSFW
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Failed to get settings' }, { status: 500 });
  }
}

/**
 * POST /api/settings/nsfw
 * 
 * Update NSFW settings. Enabling requires age confirmation.
 */
// Update NSFW settings. Enabling requires age confirmation.
export async function POST(request: NextRequest) {
  try {
    const signedAction = await request.json();
    if (signedAction.action !== 'update_nsfw_settings') {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
    const user = await requireSignedAction(signedAction);

    // Trust signed payload data
    const { nsfwEnabled, confirmAge } = updateSchema.parse(signedAction.data);

    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 500 });
    }

    const localNodeIsNsfw = await isLocalNodeNsfw();

    // A node conversion cannot consent on behalf of its existing users.
    // Unverified adult-node members must explicitly confirm they are 18+.
    if (localNodeIsNsfw && !user.ageVerifiedAt && (!nsfwEnabled || !confirmAge)) {
      return NextResponse.json({
        error: 'Age verification required',
        requiresAgeConfirmation: true,
        message: 'You must confirm you are 18 or older to access this adult-only node',
      }, { status: 400 });
    }

    // Adult-only nodes have no account-level opt-out after age confirmation.
    if (localNodeIsNsfw && user.ageVerifiedAt) {
      await db.update(users)
        .set({
          nsfwEnabled: true,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));

      return NextResponse.json({
        success: true,
        nsfwEnabled: true,
        ageVerifiedAt: user.ageVerifiedAt?.toISOString() || null,
      });
    }

    // If enabling NSFW and not already verified, require age confirmation
    if (nsfwEnabled && !user.ageVerifiedAt) {
      if (!confirmAge) {
        return NextResponse.json({
          error: 'Age verification required',
          requiresAgeConfirmation: true,
          message: 'You must confirm you are 18 or older to view NSFW content',
        }, { status: 400 });
      }

      // Record age verification
      await db.update(users)
        .set({
          nsfwEnabled: true,
          ageVerifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));

      return NextResponse.json({
        success: true,
        nsfwEnabled: true,
        ageVerifiedAt: new Date().toISOString(),
      });
    }

    // Update preference (already verified or disabling)
    await db.update(users)
      .set({
        nsfwEnabled,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    return NextResponse.json({
      success: true,
      nsfwEnabled,
      ageVerifiedAt: user.ageVerifiedAt?.toISOString() || null,
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
    console.error('NSFW settings update error:', error);
    return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 });
  }
}
