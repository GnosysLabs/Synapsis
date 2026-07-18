import { afterEach, describe, expect, it } from 'vitest';

import { openPushDeliveryToken, sealPushDeliveryToken } from './credentials';

const originalSecret = process.env.AUTH_SECRET;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = originalSecret;
});

describe('community-node push credentials', () => {
  it('encrypts and authenticates the relay delivery token', () => {
    process.env.AUTH_SECRET = 'test-auth-secret-that-is-long-enough';
    const sealed = sealPushDeliveryToken('delivery-secret', 'user-1', 'install-1');
    expect(sealed).not.toContain('delivery-secret');
    expect(openPushDeliveryToken(sealed, 'user-1', 'install-1')).toBe('delivery-secret');
    expect(() => openPushDeliveryToken(sealed, 'user-2', 'install-1')).toThrow();
  });
});
