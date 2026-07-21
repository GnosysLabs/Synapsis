import { describe, expect, it } from 'vitest';
import { aggregateSwarmStats } from './registry';

describe('aggregateSwarmStats', () => {
  it('counts the local node and active peers without historical inactive rows', () => {
    const result = aggregateSwarmStats([
      { isActive: true, userCount: 3, postCount: 24, mediaCount: 7 },
      { isActive: true, userCount: 2, postCount: 8, mediaCount: null },
      { isActive: false, userCount: 50, postCount: 500, mediaCount: 100 },
    ], {
      users: 4,
      posts: 12,
      media: 5,
    }, true);

    expect(result).toEqual({
      totalNodes: 3,
      activeNodes: 2,
      totalUsers: 9,
      totalPosts: 44,
      totalMedia: 12,
    });
  });

  it('excludes local counts when the node is not publicly participating', () => {
    const result = aggregateSwarmStats([
      { isActive: true, userCount: 3, postCount: 24, mediaCount: 7 },
    ], {
      users: 100,
      posts: 200,
      media: 300,
    }, false);

    expect(result).toEqual({
      totalNodes: 1,
      activeNodes: 1,
      totalUsers: 3,
      totalPosts: 24,
      totalMedia: 7,
    });
  });
});
