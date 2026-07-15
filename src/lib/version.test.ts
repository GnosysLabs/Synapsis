import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCurrentBuildInfo } from './version';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('build information', () => {
  it('exposes the repository commit count as a number', () => {
    vi.stubEnv('APP_COMMIT_COUNT', '288');

    expect(getCurrentBuildInfo().commitCount).toBe(288);
  });

  it('ignores an unavailable commit count', () => {
    vi.stubEnv('APP_COMMIT_COUNT', 'unknown');

    expect(getCurrentBuildInfo().commitCount).toBeNull();
  });
});
