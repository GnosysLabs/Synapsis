import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, media } from '@/db';
import { requireAuth } from '@/lib/auth';
import { completeUpload, StuffboxApiError } from '@/lib/stuffbox/client';
import { getStuffboxAccess } from '@/lib/stuffbox/tokens';

const bodySchema = z.object({ alt: z.string().max(1500).nullable().optional() });
type Context = { params: Promise<{ uploadId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const user = await requireAuth();
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const { uploadId } = await context.params;
    const { baseUrl, accessToken } = await getStuffboxAccess(user.id);
    const asset = await completeUpload(baseUrl, accessToken, uploadId);
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
