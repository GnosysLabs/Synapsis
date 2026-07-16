/**
 * Tests for client-side private key decryption
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { decryptPrivateKey, isEncryptedPrivateKey } from './private-key-client';

// Mock Web Crypto API for Node.js test environment
beforeAll(() => {
  if (typeof window === 'undefined') {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { crypto: webcrypto },
    });
  }
});

describe('private-key-client', () => {
  describe('isEncryptedPrivateKey', () => {
    it('should return true for valid encrypted key format', () => {
      const encrypted = JSON.stringify({
        encrypted: 'base64data',
        salt: 'base64salt',
        iv: 'base64iv'
      });
      expect(isEncryptedPrivateKey(encrypted)).toBe(true);
    });

    it('should return false for invalid format', () => {
      expect(isEncryptedPrivateKey('not json')).toBe(false);
      expect(isEncryptedPrivateKey('')).toBe(false);
      expect(isEncryptedPrivateKey('{}')).toBe(false);
    });
  });

  describe('decryptPrivateKey', () => {
    it('should throw error when not in browser', async () => {
      const originalWindow = global.window;
      Reflect.deleteProperty(globalThis, 'window');

      await expect(
        decryptPrivateKey({ encrypted: 'test', salt: 'test', iv: 'test' }, 'password')
      ).rejects.toThrow('Decryption can only be performed in the browser');

      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow,
      });
    });

    // Note: Full decryption test would require a valid encrypted key
    // which would need to be generated with the server-side encryption function
    // This is tested in integration tests
  });
});
