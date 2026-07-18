import { describe, expect, it } from 'vitest';
import { cliVerificationOrigin } from './authorization';

describe('CLI verification origin', () => {
  it('uses the configured public node domain behind a local reverse proxy', () => {
    expect(cliVerificationOrigin(
      'https://localhost:43822/api/cli/authorizations',
      { NEXT_PUBLIC_NODE_DOMAIN: 'rprh.link' },
    )).toBe('https://rprh.link');
  });

  it('preserves configured public ports and absolute origins', () => {
    expect(cliVerificationOrigin(
      'http://localhost:43821/api/cli/authorizations',
      { NEXT_PUBLIC_NODE_DOMAIN: 'social.example:8443' },
    )).toBe('https://social.example:8443');
    expect(cliVerificationOrigin(
      'http://localhost:43821/api/cli/authorizations',
      { NEXT_PUBLIC_NODE_DOMAIN: 'https://social.example/path' },
    )).toBe('https://social.example');
  });

  it('keeps local development on HTTP and falls back to the request origin', () => {
    expect(cliVerificationOrigin(
      'http://localhost:43822/api/cli/authorizations',
      { NEXT_PUBLIC_NODE_DOMAIN: 'localhost:43821' },
    )).toBe('http://localhost:43821');
    expect(cliVerificationOrigin(
      'http://localhost:43822/api/cli/authorizations',
      {},
    )).toBe('http://localhost:43822');
  });
});
