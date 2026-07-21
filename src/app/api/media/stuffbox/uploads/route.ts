import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth';
import {
  isCliSignedAction,
  requireCliSignedAction,
  signedActionErrorStatus,
} from '@/lib/auth/cli-credentials';
import { SignedActionError } from '@/lib/auth/verify-signature';
import { createUpload, StuffboxApiError } from '@/lib/stuffbox/client';
import { getStuffboxAccess } from '@/lib/stuffbox/tokens';
import { ALLOWED_MEDIA_TYPES } from '@/lib/media/upload-policy';
import { E2EE_MEDIA_MIME_TYPE } from '@/lib/e2ee/media-format';

const uploadSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.union([z.enum(ALLOWED_MEDIA_TYPES), z.literal(E2EE_MEDIA_MIME_TYPE)]),
  size: z.number().int().positive().safe(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export async function POST(request: Request) {
  try {
    const requestBody: unknown = await request.json();
    const cliAuthorization = isCliSignedAction(requestBody)
      ? await requireCliSignedAction(requestBody, 'media_upload_start', 'media:write')
      : null;
    const user = cliAuthorization?.user ?? await requireAuth();
    const input = uploadSchema.parse(isCliSignedAction(requestBody) ? requestBody.data : requestBody);
    const { baseUrl, accessToken } = await getStuffboxAccess(user.id);
    const upload = await createUpload(baseUrl, accessToken, input);
    return NextResponse.json(upload, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      const firstIssue = error.issues[0];
      const message = firstIssue?.path[0] === 'mimeType'
        ? 'This file type is not supported.'
        : firstIssue?.message || 'Invalid upload';
      return NextResponse.json({ error: message, code: 'INVALID_UPLOAD', details: error.issues }, { status: 400 });
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
