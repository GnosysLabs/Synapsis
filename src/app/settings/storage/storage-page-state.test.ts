import { describe, expect, it } from 'vitest';

import { getStoragePageState } from './storage-page-state';

describe('storage page render gate', () => {
  it('never treats missing initial status as a disconnected account', () => {
    expect(getStoragePageState(null, true)).toBe('loading');
  });

  it('renders the connection UI only after a disconnected status is loaded', () => {
    expect(getStoragePageState({ provider: null }, false)).toBe('disconnected');
    expect(getStoragePageState({ provider: 'stuffbox' }, false)).toBe('connected');
  });
});
