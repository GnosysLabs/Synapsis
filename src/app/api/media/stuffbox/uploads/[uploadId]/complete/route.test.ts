import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db';
import { requireAuth } from '@/lib/auth';
import { requireCliSignedAction } from '@/lib/auth/cli-credentials';
import { completeUpload } from '@/lib/stuffbox/client';
import { getStuffboxAccess } from '@/lib/stuffbox/tokens';
import { POST } from './route';

vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('@/lib/auth/cli-credentials', () => ({
  isCliSignedAction: (value: unknown) => Boolean(value && typeof value === 'object' && 'credentialId' in value),
  requireCliSignedAction: vi.fn(),
  signedActionErrorStatus: vi.fn(() => 403),
}));
vi.mock('@/lib/auth/verify-signature', () => ({
  SignedActionError: class MockSignedActionError extends Error {},
}));
vi.mock('@/lib/stuffbox/client', () => ({
  completeUpload: vi.fn(),
  StuffboxApiError: class MockStuffboxApiError extends Error {},
}));
vi.mock('@/lib/stuffbox/tokens', () => ({ getStuffboxAccess: vi.fn() }));
vi.mock('@/db', () => ({
  db: {
    query: { media: { findFirst: vi.fn() } },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(),
      })),
    })),
  },
  media: {},
}));

describe('POST /api/media/stuffbox/uploads/:id/complete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAuth).mockResolvedValue({ id: 'user-1' } as Awaited<ReturnType<typeof requireAuth>>);
    vi.mocked(requireCliSignedAction).mockResolvedValue({
      user: { id: 'user-1' },
      credential: { id: 'credential-1' },
    } as Awaited<ReturnType<typeof requireCliSignedAction>>);
    vi.mocked(getStuffboxAccess).mockResolvedValue({
      baseUrl: 'https://stuffbox.example',
      accessToken: 'stuffbox-token',
    });
    vi.mocked(completeUpload).mockResolvedValue({
      id: 'asset-1',
      publicId: 'public-1',
      url: 'https://cdn.example/cover.png',
      filename: 'cover.png',
      mimeType: 'image/png',
      byteSize: 1024,
      status: 'active',
      createdAt: '2026-07-17T00:00:00.000Z',
    });
    vi.mocked(db.query.media.findFirst).mockResolvedValue(undefined);
    const returning = vi.fn().mockResolvedValue([{
      id: 'media-1',
      userId: 'user-1',
      url: 'https://cdn.example/cover.png',
      altText: 'A cover',
    }]);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn(() => ({ returning })),
    } as never);
  });

  it('finishes a scoped CLI upload and creates an unattached media record', async () => {
    const action = {
      action: 'media_upload_complete',
      data: { uploadId: 'upload-1', alt: 'A cover' },
      credentialId: '00000000-0000-4000-8000-000000000001',
      ts: Date.now(),
      nonce: 'nonce',
      sig: 'signature',
    };
    const response = await POST(new Request('https://social.example/api/media/stuffbox/uploads/upload-1/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    }), { params: Promise.resolve({ uploadId: 'upload-1' }) });

    expect(response.status).toBe(200);
    expect(requireCliSignedAction).toHaveBeenCalledWith(action, 'media_upload_complete', 'media:write');
    expect(requireAuth).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ media: { id: 'media-1', altText: 'A cover' } });
  });

  it('rejects an upload id that differs from the signed data', async () => {
    const response = await POST(new Request('https://social.example/api/media/stuffbox/uploads/upload-1/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'media_upload_complete',
        data: { uploadId: 'upload-2' },
        credentialId: '00000000-0000-4000-8000-000000000001',
        ts: Date.now(), nonce: 'nonce', sig: 'signature',
      }),
    }), { params: Promise.resolve({ uploadId: 'upload-1' }) });

    expect(response.status).toBe(400);
    expect(completeUpload).not.toHaveBeenCalled();
  });

  it('preserves browser-session upload completion', async () => {
    const response = await POST(new Request('https://social.example/api/media/stuffbox/uploads/upload-1/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alt: 'A cover' }),
    }), { params: Promise.resolve({ uploadId: 'upload-1' }) });

    expect(response.status).toBe(200);
    expect(requireAuth).toHaveBeenCalledOnce();
    expect(requireCliSignedAction).not.toHaveBeenCalled();
    expect(completeUpload).toHaveBeenCalledWith('https://stuffbox.example', 'stuffbox-token', 'upload-1');
  });
});
