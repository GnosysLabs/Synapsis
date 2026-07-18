import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Database } from '@tursodatabase/database';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/tursodatabase/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { db as productionDatabase } from '@/db';
import { relations } from '@/db/relations';
import { seedFollowSyncStates } from '@/lib/background/remote-sync';
import { seedSwarmContentSyncStates } from './content-cache';

function testDatabase(client: Database) {
  return drizzle({ client, relations });
}

describe('SQLite synchronization state seeding', () => {
  let client: Database;
  let database: ReturnType<typeof testDatabase>;

  beforeEach(async () => {
    client = new Database(':memory:');
    await client.connect();
    database = testDatabase(client);
    await client.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE swarm_nodes (
        id text PRIMARY KEY,
        domain text NOT NULL UNIQUE,
        is_active integer DEFAULT 1 NOT NULL,
        is_blocked integer DEFAULT 0 NOT NULL,
        trust_score integer DEFAULT 50 NOT NULL,
        public_key text,
        discovered_via text,
        nsfw_classification_known integer DEFAULT 0 NOT NULL
      );
      CREATE TABLE swarm_content_sync_states (
        domain text PRIMARY KEY NOT NULL REFERENCES swarm_nodes(domain) ON DELETE CASCADE
      );
      CREATE TABLE remote_follows (
        id text PRIMARY KEY,
        target_handle text NOT NULL
      );
      CREATE TABLE remote_follow_sync_states (
        target_handle text PRIMARY KEY NOT NULL,
        node_domain text NOT NULL
      );
    `);
  });

  afterEach(async () => {
    await client.close();
  });

  it('uses unqualified SQLite conflict-target columns for both seeders', async () => {
    await client.exec(`
      INSERT INTO swarm_nodes (
        id, domain, public_key, discovered_via, nsfw_classification_known
      ) VALUES ('peer', 'remote.social', 'PINNED KEY', 'direct', 1);
      INSERT INTO remote_follows (id, target_handle)
      VALUES ('follow', 'Alice@Remote.Social');
    `);

    const runnableDatabase = database as Pick<typeof productionDatabase, 'run'>;
    await seedSwarmContentSyncStates(runnableDatabase);
    await seedFollowSyncStates(runnableDatabase);

    const contentStates = await database.all<{ domain: string }>(sql.raw(
      'SELECT domain FROM swarm_content_sync_states',
    ));
    const followStates = await database.all<{ target_handle: string; node_domain: string }>(sql.raw(
      'SELECT target_handle, node_domain FROM remote_follow_sync_states',
    ));

    expect(contentStates).toEqual([{ domain: 'remote.social' }]);
    expect(followStates).toEqual([{
      target_handle: 'alice@remote.social',
      node_domain: 'remote.social',
    }]);
  });

  it('schedules established peers for bounded recovery even when trust is quarantined', async () => {
    await client.exec(`
      INSERT INTO swarm_nodes (
        id, domain, is_active, is_blocked, trust_score, public_key,
        discovered_via, nsfw_classification_known
      ) VALUES
        ('recovering', 'recovering.social', 1, 0, 0, 'PINNED', 'announcement', 1),
        ('gossip', 'gossip.social', 1, 0, 100, NULL, 'relay.social', 0),
        ('blocked', 'blocked.social', 1, 1, 100, 'PINNED', 'direct', 1),
        ('inactive', 'inactive.social', 0, 0, 100, 'PINNED', 'direct', 1);
    `);

    const runnableDatabase = database as Pick<typeof productionDatabase, 'run'>;
    await seedSwarmContentSyncStates(runnableDatabase);

    const contentStates = await database.all<{ domain: string }>(sql.raw(
      'SELECT domain FROM swarm_content_sync_states ORDER BY domain',
    ));
    expect(contentStates).toEqual([{ domain: 'recovering.social' }]);
  });
});

describe('legacy swarm synchronization migration', () => {
  it('repairs a non-unique legacy peer table without losing sync cursors', async () => {
    const client = new Database(':memory:');
    await client.connect();
    try {
      await client.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE swarm_nodes (
          id text PRIMARY KEY,
          domain text NOT NULL
        );
        CREATE INDEX swarm_nodes_domain_idx ON swarm_nodes(domain);
        CREATE TABLE swarm_content_sync_states (
          domain text PRIMARY KEY NOT NULL REFERENCES swarm_nodes(domain) ON DELETE CASCADE,
          failures integer DEFAULT 0 NOT NULL,
          next_attempt_at integer DEFAULT (unixepoch()) NOT NULL,
          last_attempt_at integer,
          last_success_at integer,
          high_water_at integer,
          high_water_id text,
          change_cursor integer,
          account_change_cursor integer,
          legacy_reconcile_cursor text,
          legacy_reconcile_complete integer DEFAULT 0 NOT NULL,
          lease_owner text,
          lease_expires_at integer,
          last_error text,
          updated_at integer DEFAULT (unixepoch()) NOT NULL
        );
        INSERT INTO swarm_nodes (id, domain)
        VALUES ('old-peer', 'remote.social'), ('duplicate-peer', 'remote.social');
        INSERT INTO swarm_content_sync_states (domain, change_cursor)
        VALUES ('remote.social', 42);
        PRAGMA foreign_keys = ON;
      `);

      const migration = readFileSync(
        resolve('drizzle/20260718271000_swarm_sync_compat/migration.sql'),
        'utf8',
      ).replaceAll('--> statement-breakpoint', '');
      await client.exec(migration);

      const database = testDatabase(client);
      const [peers] = await database.all<{ count: number }>(sql.raw(
        "SELECT count(*) AS count FROM swarm_nodes WHERE domain = 'remote.social'",
      ));
      const [state] = await database.all<{ change_cursor: number }>(sql.raw(
        "SELECT change_cursor FROM swarm_content_sync_states WHERE domain = 'remote.social'",
      ));
      const violations = await database.all(sql.raw('PRAGMA foreign_key_check'));
      const indexes = await database.all<{
        name: string;
        unique: number;
      }>(sql.raw("PRAGMA index_list('swarm_nodes')"));

      expect(peers?.count).toBe(1);
      expect(state?.change_cursor).toBe(42);
      expect(violations).toEqual([]);
      expect(indexes).toContainEqual(expect.objectContaining({
        name: 'swarm_nodes_domain_unique_idx',
        unique: 1,
      }));
    } finally {
      await client.close();
    }
  });
});
