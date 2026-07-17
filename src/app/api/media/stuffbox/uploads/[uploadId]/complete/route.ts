import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, media } from '@/db';
import { requireAuth } from '@/lib/auth';
import {
  isCliSignedAction,
  requireCliSignedAction,
  signedActionErrorStatus,
} from '@/lib/auth/cli-credentials';
import { SignedActionError } from '@/lib/auth/verify-signature';
import { completeUpload, StuffboxApiError } from '@/lib/stuffbox/client';
import { getStuffboxAccess } from '@/lib/stuffbox/tokens';

const bodySchema = z.object({ alt: z.string().max(1500).nullable().optional() });
const cliBodySchema = bodySchema.extend({ uploadId: z.string().min(1) });
type Context = { params: Promise<{ uploadId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const { uploadId } = await context.params;
    const requestBody: unknown = await request.json().catch(() => ({}));
    const cliAuthorization = isCliSignedAction(requestBody)
      ? await requireCliSignedAction(requestBody, 'media_upload_complete', 'media:write')
      : null;
    const user = cliAuthorization?.user ?? await requireAuth();
    const body = isCliSignedAction(requestBody)
      ? cliBodySchema.parse(requestBody.data)
      : bodySchema.parse(requestBody);
    if ('uploadId' in body && body.uploadId !== uploadId) {
      return NextResponse.json({ error: 'Upload mismatch', code: 'INVALID_ACTION' }, { status: 400 });
    }
    const { baseUrl, accessToken } = await getStuffboxAccess(user.id);
    const asset = await completeUpload(baseUrl, accessToken, uploadId);
    const existing = await db.query.media.findFirst({
      where: {
        AND: [
          { userId: user.id },
          { storageProvider: 'stuffbox' },
          { storageAssetId: asset.id },
        ],
      },
    });
    if (existing) {
      return NextResponse.json({ success: true, media: existing, asset });
    }
    const [record] = await db.insert(media).values({
      userId: user.id,
      postId: null,
      url: asset.url,
      storageProvider: 'stuffbox',
      storageAssetId: asset.id,
      altText: body.alt ?? null,
      mimeType: asset.mimeType,
      width: 0,
      height: 0,
    }).returning();
    return NextResponse.json({ success: true, media: record, asset });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid upload completion' }, { status: 400 });
    }
    if (error instanceof SignedActionError) {
      return NextResponse.json({ error: 'Signed upload action rejected', code: error.code }, {
        status: signedActionErrorStatus(error),
      });
    }
    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    if (error instanceof Error && error.message === 'STUFFBOX_NOT_CONNECTED') {
      return NextResponse.json({ error: 'Stuffbox is disconnected', code: 'STORAGE_NOT_CONFIGURED' }, { status: 409 });
    }
    if (error instanceof StuffboxApiError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status || 502 });
    }
    console.error('Stuffbox upload completion error:', error);
    return NextResponse.json({ error: 'Unable to complete upload' }, { status: 500 });
  }
}
