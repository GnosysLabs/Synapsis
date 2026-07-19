import { describe, expect, it } from 'vitest';

import { decodeDynamicRouteSegment } from './route-params';

describe('decodeDynamicRouteSegment', () => {
  it('normalizes a federated handle before it is encoded into another URL', () => {
    const handle = decodeDynamicRouteSegment('bubbabator%40batorbros.bond');

    expect(handle).toBe('bubbabator@batorbros.bond');
    expect(encodeURIComponent(handle)).toBe('bubbabator%40batorbros.bond');
  });

  it('preserves malformed input so the destination route can reject it', () => {
    expect(decodeDynamicRouteSegment('user%2')).toBe('user%2');
  });
});
