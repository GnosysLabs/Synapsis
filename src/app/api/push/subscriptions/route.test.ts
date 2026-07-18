import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  sealPushDeliveryToken: vi.fn(),
  insert: vi.fn(),
  values: vi.fn(),
  onConflictDoUpdate: vi.fn(),
  delete: vi.fn(),
  where: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/push/credentials', () => ({
  sealPushDeliveryToken: mocks.sealPushDeliveryToken,
}));
vi.mock('@/db', () => ({
  db: { insert: mocks.insert, delete: mocks.delete },
  pushSubscriptions: {
    userId: 'user_id',
    installationId: 'installation_id',
  },
}));

import { DELETE, PUT } from './route';

const subscription = {
  installationId: '00000000-0000-4000-8000-000000000001',
  relaySubscriptionId: '00000000-0000-4000-8000-000000000002',
  relayDeliveryToken: 'abcdefghijklmnopqrstuvwxyzABCDEFG_123456789',
  environment: 'production',
  topic: 'xyz.gnosyslabs.synapsis',
  preferences: {
    follow: true,
    reply: true,
    mention: true,
    like: false,
    repost: false,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ id: 'user-1' });
  mocks.sealPushDeliveryToken.mockReturnValue('encrypted-delivery-token');
  mocks.onConflictDoUpdate.mockResolvedValue(undefined);
  mocks.values.mockReturnValue({ onConflictDoUpdate: mocks.onConflictDoUpdate });
  mocks.insert.mockReturnValue({ values: mocks.values });
  mocks.where.mockResolvedValue(undefined);
  mocks.delete.mockReturnValue({ where: mocks.where });
});

describe('/api/push/subscriptions', () => {
  it('stores only an encrypted relay delivery token for the authenticated user', async () => {
    const response = await PUT(new NextRequest('https://node.example/api/push/subscriptions', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(subscription),
    }));

    expect(response.status).toBe(204);
    expect(mocks.sealPushDeliveryToken).toHaveBeenCalledWith(
      subscription.relayDeliveryToken,
      'user-1',
      subscription.installationId,
    );
    const stored = mocks.values.mock.calls[0][0];
    expect(stored.userId).toBe('user-1');
    expect(stored.relayDeliveryTokenEncrypted).toBe('encrypted-delivery-token');
    expect(JSON.stringify(stored)).not.toContain(subscription.relayDeliveryToken);
    expect(mocks.onConflictDoUpdate).toHaveBeenCalledOnce();
  });

  it('rejects registrations for any other APNs topic', async () => {
    const response = await PUT(new NextRequest('https://node.example/api/push/subscriptions', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...subscription, topic: 'com.attacker.app' }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('removes only the authenticated user installation', async () => {
    const response = await DELETE(new NextRequest('https://node.example/api/push/subscriptions', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installationId: subscription.installationId }),
    }));

    expect(response.status).toBe(204);
    expect(mocks.delete).toHaveBeenCalledOnce();
    expect(mocks.where).toHaveBeenCalledOnce();
  });
});
