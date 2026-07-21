import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isTrustedFederationMediaUrl,
  sanitizeFederationMediaUrl,
} from './federation';

describe('trusted federation media origins', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('allows the standard Stuffbox origin and its CDN subdomains in production', () => {
    expect(isTrustedFederationMediaUrl(
      'https://stuffbox.xyz/assets/one',
      { production: true },
    )).toBe(true);
    expect(isTrustedFederationMediaUrl(
      'https://cdn.stuffbox.xyz/assets/two',
      { production: true },
    )).toBe(true);
  });

  it('rejects an arbitrary peer-controlled tracking origin in production', () => {
    expect(isTrustedFederationMediaUrl(
      'https://malicious-node.social/pixel.gif',
      { production: true },
    )).toBe(false);
  });

  it('accepts exact operator-configured CDN origins without trusting sibling hosts', () => {
    const policy = {
      production: true,
      configuredOrigins: 'https://media.community.example',
    };
    expect(isTrustedFederationMediaUrl('https://media.community.example/video.mp4', policy)).toBe(true);
    expect(isTrustedFederationMediaUrl('https://evil.media.community.example/video.mp4', policy)).toBe(false);
  });

  it('drops unsafe optional branding without relaxing the production media policy', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(sanitizeFederationMediaUrl('https://stuffbox.xyz/f/node-logo')).toBe(
      'https://stuffbox.xyz/f/node-logo',
    );
    expect(sanitizeFederationMediaUrl('https://peer.social/api/node/logo?v=1')).toBeUndefined();
  });
});
