import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('For You migration', () => {
  it('persists local learning signals and stable infinite-scroll sessions', () => {
    const migration = readFileSync(resolve(
      'drizzle/20260721003000_for_you_feed/migration.sql',
    ), 'utf8');

    expect(migration).toContain('CREATE TABLE `feed_impressions`');
    expect(migration).toContain('CREATE TABLE `feed_feedback`');
    expect(migration).toContain('CREATE TABLE `for_you_feed_sessions`');
    expect(migration).toContain('CREATE TABLE `for_you_feed_items`');
    expect(migration).toContain('for_you_feed_items_post_unique_idx');
    expect(migration).toMatch(/UPDATE `swarm_content_sync_states`[\s\S]*`change_cursor` = NULL/);
  });
});
