import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Database } from '@tursodatabase/database';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/tursodatabase/database';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'drizzle/20260717230000_restore_legacy_adult_node_consent/migration.sql',
);

interface Scenario {
  nodeIsNsfw: boolean;
  nodeCreatedAt: number;
  userCreatedAt: number;
  localPasswordAccount?: boolean;
}

async function runMigration({
  nodeIsNsfw,
  nodeCreatedAt,
  userCreatedAt,
  localPasswordAccount = true,
}: Scenario) {
  const client = new Database(':memory:');
  await client.connect();
  const database = drizzle({ client });

  try {
    await database.run(sql.raw(`
      CREATE TABLE nodes (
        is_nsfw integer NOT NULL,
        created_at integer NOT NULL
      )
    `));
    await database.run(sql.raw(`
      CREATE TABLE users (
        id text PRIMARY KEY,
        handle text NOT NULL,
        email text,
        password_hash text,
        nsfw_enabled integer NOT NULL,
        age_verified_at integer,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      )
    `));
    await database.run(sql.raw(
      `INSERT INTO nodes (is_nsfw, created_at) VALUES (${nodeIsNsfw ? 1 : 0}, ${nodeCreatedAt})`,
    ));
    await database.run(sql.raw(`
      INSERT INTO users (
        id, handle, email, password_hash, nsfw_enabled,
        age_verified_at, created_at, updated_at
      ) VALUES (
        'user-1',
        '${localPasswordAccount ? 'local-user' : 'remote@other.example'}',
        ${localPasswordAccount ? "'user@example.com'" : 'NULL'},
        ${localPasswordAccount ? "'password-hash'" : 'NULL'},
        0,
        NULL,
        ${userCreatedAt},
        0
      )
    `));

    const migration = await readFile(migrationPath, 'utf8');
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) await database.run(sql.raw(statement));
    }

    return {
      nodes: await database.all<{
        nsfwActivatedAt: number | null;
      }>(sql.raw('SELECT nsfw_activated_at AS nsfwActivatedAt FROM nodes')),
      users: await database.all<{
        nsfwEnabled: number;
        ageVerifiedAt: number | null;
      }>(sql.raw(`
        SELECT
          nsfw_enabled AS nsfwEnabled,
          age_verified_at AS ageVerifiedAt
        FROM users
      `)),
    };
  } finally {
    await client.close();
  }
}

describe('legacy adult-node consent restoration', () => {
  it('restores a local account created after its legacy adult node existed', async () => {
    await expect(runMigration({
      nodeIsNsfw: true,
      nodeCreatedAt: 100,
      userCreatedAt: 200,
    })).resolves.toEqual({
      nodes: [{ nsfwActivatedAt: 100 }],
      users: [{ nsfwEnabled: 1, ageVerifiedAt: 200 }],
    });
  });

  it('does not verify an account that predates a tracked adult activation boundary', async () => {
    const result = await runMigration({
      nodeIsNsfw: true,
      nodeCreatedAt: 300,
      userCreatedAt: 200,
    });

    expect(result.users).toEqual([{ nsfwEnabled: 0, ageVerifiedAt: null }]);
  });

  it('does not verify remote cache rows on an adult node', async () => {
    const result = await runMigration({
      nodeIsNsfw: true,
      nodeCreatedAt: 100,
      userCreatedAt: 200,
      localPasswordAccount: false,
    });

    expect(result.users).toEqual([{ nsfwEnabled: 0, ageVerifiedAt: null }]);
  });

  it('does not alter accounts on a general-purpose node', async () => {
    await expect(runMigration({
      nodeIsNsfw: false,
      nodeCreatedAt: 100,
      userCreatedAt: 200,
    })).resolves.toEqual({
      nodes: [{ nsfwActivatedAt: null }],
      users: [{ nsfwEnabled: 0, ageVerifiedAt: null }],
    });
  });
});
