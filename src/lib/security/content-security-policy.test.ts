import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../../../next.config';

describe('content security policy', () => {
  it('allows HTTPS media served by connected storage providers', () => {
    expect(contentSecurityPolicy).toContain("media-src 'self' blob: https:");
  });
});
