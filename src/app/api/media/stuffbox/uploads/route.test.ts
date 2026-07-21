import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requireAuth } from '@/lib/auth';
import { requireCliSignedAction } from '@/lib/auth/cli-credentials';
import { createUpload } from '@/lib/stuffbox/client';
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
  createUpload: vi.fn(),
  StuffboxApiError: class MockStuffboxApiError extends Error {},
}));
vi.mock('@/lib/stuffbox/tokens', () => ({ getStuffboxAccess: vi.fn() }));

describe('POST /api/media/stuffbox/uploads', () => {
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
    vi.mocked(createUpload).mockResolvedValue({
      id: 'upload-1',
      uploadUrl: 'https://stuffbox.example/direct',
      method: 'PUT',
      requiredHeaders: {},
      expiresAt: '2026-07-18T00:00:00.000Z',
    });
  });

  it('starts a Stuffbox upload for a scoped CLI action without a browser session', async () => {
    const action = {
      action: 'media_upload_start',
      data: {
        filename: 'cover.png',
        mimeType: 'image/png',
        size: 1024,
        sha256: 'a'.repeat(64),
      },
      credentialId: '00000000-0000-4000-8000-000000000001',
      ts: Date.now(),
      nonce: 'nonce',
      sig: 'signature',
    };
    const response = await POST(new Request('https://social.example/api/media/stuffbox/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    }));

    expect(response.status).toBe(201);
    expect(requireCliSignedAction).toHaveBeenCalledWith(action, 'media_upload_start', 'media:write');
    expect(requireAuth).not.toHaveBeenCalled();
    expect(createUpload).toHaveBeenCalledWith('https://stuffbox.example', 'stuffbox-token', action.data);
  });

  it('preserves browser-session uploads', async () => {
    const upload = {
      filename: 'cover.png',
      mimeType: 'image/png',
      size: 1024,
    };
    const response = await POST(new Request('https://social.example/api/media/stuffbox/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(upload),
    }));

    expect(response.status).toBe(201);
    expect(requireAuth).toHaveBeenCalledOnce();
    expect(requireCliSignedAction).not.toHaveBeenCalled();
    expect(createUpload).toHaveBeenCalledWith('https://stuffbox.example', 'stuffbox-token', upload);
  });

  it('forwards large uploads to Stuffbox so the account quota decides', async () => {
    const upload = {
      filename: 'feature-film.mp4',
      mimeType: 'video/mp4' as const,
      size: 8 * 1024 * 1024 * 1024,
    };
    const response = await POST(new Request('https://social.example/api/media/stuffbox/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(upload),
    }));

    expect(response.status).toBe(201);
    expect(createUpload).toHaveBeenCalledWith('https://stuffbox.example', 'stuffbox-token', upload);
  });

  it('forwards opaque client-encrypted chat media without treating it as a public post type', async () => {
    const upload = {
      filename: 'encrypted-chat-media.e2ee',
      mimeType: 'application/vnd.stuffbox.client-encrypted',
      size: 1_040,
    };
    const response = await POST(new Request('https://social.example/api/media/stuffbox/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(upload),
    }));

    expect(response.status).toBe(201);
    expect(createUpload).toHaveBeenCalledWith('https://stuffbox.example', 'stuffbox-token', upload);
  });
});
