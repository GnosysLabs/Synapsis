import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import { createUpload, StuffboxApiError } from '@/lib/stuffbox/client';
import { getStuffboxAccess } from '@/lib/stuffbox/tokens';

const uploadSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.enum([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'video/mp4', 'video/webm', 'video/quicktime',
  ]),
  size: z.number().int().positive().max(100 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).superRefine((upload, context) => {
  if (upload.mimeType.startsWith('image/') && upload.size > 10 * 1024 * 1024) {
    context.addIssue({ code: 'too_big', maximum: 10 * 1024 * 1024, origin: 'number', inclusive: true, path: ['size'], message: 'Images must be 10MB or smaller' });
  }
});

export async function POST(request: Request) {
  try {
    const user = await requireAuth();
    const input = uploadSchema.parse(await request.json());
    const { baseUrl, accessToken } = await getStuffboxAccess(user.id);
    const upload = await createUpload(baseUrl, accessToken, input);
    return NextResponse.json(upload, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid upload', details: error.issues }, { status: 400 });
    }
    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    if (error instanceof Error && error.message === 'STUFFBOX_NOT_CONNECTED') {
      return NextResponse.json({
        error: 'Connect Stuffbox before uploading media.',
        code: 'STORAGE_NOT_CONFIGURED',
      }, { status: 409 });
    }
    if (error instanceof StuffboxApiError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status || 502 });
    }
    console.error('Stuffbox upload-session error:', error);
    return NextResponse.json({ error: 'Unable to create upload session' }, { status: 500 });
  }
}
