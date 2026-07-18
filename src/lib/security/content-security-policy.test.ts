import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../../../next.config';

describe('content security policy', () => {
  it('allows HTTPS media served by connected storage providers', () => {
    expect(contentSecurityPolicy).toContain("media-src 'self' blob: https:");
  });

  it('only permits the explicit click-to-load video frame providers', () => {
    expect(contentSecurityPolicy).toContain(
      'frame-src https://challenges.cloudflare.com https://www.youtube-nocookie.com https://player.vimeo.com',
    );
  });
});
