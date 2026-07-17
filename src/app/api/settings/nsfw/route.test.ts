import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as updateViewingPreference } from './route';
import { POST as updateAccountPreference } from '../account-nsfw/route';
import { requireSignedAction, SignedActionError } from '@/lib/auth/verify-signature';
import { db } from '@/db';

const nodeMocks = vi.hoisted(() => ({
  isLocalNodeNsfw: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));

vi.mock('@/lib/node/local-node', () => ({
  isLocalNodeNsfw: nodeMocks.isLocalNodeNsfw,
}));

vi.mock('@/lib/auth/verify-signature', () => {
  class MockSignedActionError extends Error {}

  return {
    requireSignedAction: vi.fn(),
    SignedActionError: MockSignedActionError,
  };
});

vi.mock('drizzle-orm', () => ({ eq: vi.fn(() => ({})) }));

vi.mock('@/db', () => {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));

  return {
    db: { update },
    users: { id: 'id' },
  };
});

const signedAction = (action: string, data: Record<string, unknown>) => ({
  action,
  data,
  did: 'did:synapsis:test',
  handle: 'tester',
  ts: Date.now(),
  nonce: 'nonce',
  sig: 'signature',
});

const request = (body: unknown) => new Request('http://localhost/api/settings/nsfw', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('NSFW settings mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nodeMocks.isLocalNodeNsfw.mockResolvedValue(false);
    vi.mocked(requireSignedAction).mockResolvedValue({
      id: 'user-id',
      ageVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    } as never);
  });

  it('accepts a signed viewing-preference update', async () => {
    const payload = signedAction('update_nsfw_settings', { nsfwEnabled: true });
    const response = await updateViewingPreference(request(payload) as never);

    expect(response.status).toBe(200);
    expect(requireSignedAction).toHaveBeenCalledWith(payload);
    expect(db?.update).toHaveBeenCalled();
  });

  it('keeps viewing enabled on an adult node even if an old client submits false', async () => {
    nodeMocks.isLocalNodeNsfw.mockResolvedValue(true);
    const payload = signedAction('update_nsfw_settings', { nsfwEnabled: false });

    const response = await updateViewingPreference(request(payload) as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ nsfwEnabled: true });
  });

  it('does not opt an unverified account in when its node becomes adult-only', async () => {
    nodeMocks.isLocalNodeNsfw.mockResolvedValue(true);
    vi.mocked(requireSignedAction).mockResolvedValue({
      id: 'unverified-user-id',
      ageVerifiedAt: null,
    } as never);
    const payload = signedAction('update_nsfw_settings', { nsfwEnabled: false });

    const response = await updateViewingPreference(request(payload) as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      requiresAgeConfirmation: true,
    });
  });

  it('allows an adult-node member to opt in only after explicit age confirmation', async () => {
    nodeMocks.isLocalNodeNsfw.mockResolvedValue(true);
    vi.mocked(requireSignedAction).mockResolvedValue({
      id: 'unverified-user-id',
      ageVerifiedAt: null,
    } as never);
    const payload = signedAction('update_nsfw_settings', {
      nsfwEnabled: true,
      confirmAge: true,
    });

    const response = await updateViewingPreference(request(payload) as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      nsfwEnabled: true,
      ageVerifiedAt: expect.any(String),
    });
  });

  it('lets an unverified legacy account persist age confirmation', async () => {
    vi.mocked(requireSignedAction).mockResolvedValue({
      id: 'legacy-user-id',
      ageVerifiedAt: null,
    } as never);
    const payload = signedAction('update_nsfw_settings', {
      nsfwEnabled: true,
      confirmAge: true,
    });
    const response = await updateViewingPreference(request(payload) as never);

    expect(response.status).toBe(200);
    expect(db?.update).toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      nsfwEnabled: true,
      ageVerifiedAt: expect.any(String),
    });
  });

  it('accepts a signed account-level update', async () => {
    const payload = signedAction('update_account_nsfw', { isNsfw: true });
    const response = await updateAccountPreference(request(payload) as never);

    expect(response.status).toBe(200);
    expect(requireSignedAction).toHaveBeenCalledWith(payload);
    expect(await response.json()).toMatchObject({ success: true, isNsfw: true });
  });

  it('rejects the old unsigned request shape', async () => {
    const response = await updateViewingPreference(request({ nsfwEnabled: true }) as never);

    expect(response.status).toBe(400);
    expect(requireSignedAction).not.toHaveBeenCalled();
  });

  it('returns a useful identity error when verification fails', async () => {
    vi.mocked(requireSignedAction).mockRejectedValue(new SignedActionError('INVALID_SIGNATURE'));
    const payload = signedAction('update_nsfw_settings', { nsfwEnabled: true });
    const response = await updateViewingPreference(request(payload) as never);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'Your identity could not be verified. Please unlock it and try again.',
    });
  });
});
