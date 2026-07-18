import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { openDeviceToken, sealDeviceToken, tokenHash, tokenMatches } from './crypto';

describe('push relay credentials', () => {
  it('encrypts APNs tokens with subscription-bound authenticated encryption', () => {
    const key = crypto.randomBytes(32);
    const sealed = sealDeviceToken('aabbccdd', 'subscription-1', key);
    expect(openDeviceToken(sealed, 'subscription-1', key)).toBe('aabbccdd');
    expect(() => openDeviceToken(sealed, 'subscription-2', key)).toThrow();
  });

  it('compares bearer token digests without storing raw tokens', () => {
    const digest = tokenHash('secret-token');
    expect(tokenMatches('secret-token', digest)).toBe(true);
    expect(tokenMatches('wrong-token', digest)).toBe(false);
  });
});
