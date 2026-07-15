import { describe, expect, it } from 'vitest';

import { mentionRetryDelayMs } from './delivery';

describe('mention delivery retry schedule', () => {
  it('uses bounded exponential backoff', () => {
    expect(mentionRetryDelayMs(1)).toBe(30_000);
    expect(mentionRetryDelayMs(2)).toBe(60_000);
    expect(mentionRetryDelayMs(3)).toBe(120_000);
    expect(mentionRetryDelayMs(20)).toBe(3_600_000);
  });
});
