import { describe, expect, it } from 'vitest';
import { resolveSessionTokens } from './session-cookie';

describe('resolveSessionTokens', () => {
  it('recovers a valid active session when the multi-account cookie is missing', () => {
    expect(resolveSessionTokens('active-token', [])).toEqual(['active-token']);
  });

  it('puts an unlisted active session ahead of stale listed sessions', () => {
    expect(resolveSessionTokens('active-token', ['older-token'])).toEqual([
      'active-token',
      'older-token',
    ]);
  });

  it('does not duplicate an active session already in the list', () => {
    expect(resolveSessionTokens('active-token', ['active-token', 'other-token'])).toEqual([
      'active-token',
      'other-token',
    ]);
  });
});
