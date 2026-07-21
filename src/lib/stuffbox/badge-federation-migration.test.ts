import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Stuffbox badge federation migration', () => {
  it('publishes local badge changes through the post change stream', () => {
    const migration = readFileSync(resolve(
      'drizzle/20260721005000_stuffbox_badge_federation/migration.sql',
    ), 'utf8');

    expect(migration).toContain('AFTER UPDATE OF `handle`, `username`, `home_domain`');
    expect(migration).toContain('`stuffbox_badge_proof`');
    expect(migration).toContain('`stuffbox_badge_level`');
    expect(migration).toContain('`stuffbox_badge_plan`');
    expect(migration).toMatch(/UPDATE `posts` SET `content` = `content`[\s\S]*`user_id` = NEW\.`id`/);
    expect(migration).toMatch(/WHERE `is_local_account` = 1[\s\S]*`stuffbox_badge_proof` IS NOT NULL/);
  });
});
