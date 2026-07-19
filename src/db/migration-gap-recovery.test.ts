import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@tursodatabase/database';
import { drizzle } from 'drizzle-orm/tursodatabase/database';
import { migrate } from 'drizzle-orm/tursodatabase/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';

const RESTORED_MIGRATIONS = [
  '20260718261000_dm_conversation_ingress_quota',
  '20260718262000_handle_hint_caps',
  '20260718270000_swarm_content_cache',
  '20260718271000_swarm_sync_compat',
  '20260718272000_federation_recovery',
  '20260718273000_repair_remote_identity_aliases',
] as const;
const LATER_MIGRATION = '20260719021000_post_collections';

describe('migration gap recovery', () => {
  it('fills restored named migrations even when a later migration is already recorded', async () => {
    const migrationsFolder = mkdtempSync(join(tmpdir(), 'synapsis-migration-gap-'));
    const client = new Database(':memory:');

    try {
      for (const name of [...RESTORED_MIGRATIONS, LATER_MIGRATION]) {
        const folder = join(migrationsFolder, name);
        mkdirSync(folder);
        writeFileSync(
          join(folder, 'migration.sql'),
          `INSERT INTO migration_probe (name) VALUES ('${name}');`,
        );
      }

      await client.connect();
      await client.exec(`
        CREATE TABLE migration_probe (
          name text PRIMARY KEY NOT NULL
        );
        CREATE TABLE __drizzle_migrations (
          id integer PRIMARY KEY,
          hash text NOT NULL,
          created_at numeric,
          name text,
          applied_at text
        );
        INSERT INTO migration_probe (name) VALUES ('${LATER_MIGRATION}');
      `);

      const migrations = readMigrationFiles({ migrationsFolder });
      const later = migrations.find((migration) => migration.name === LATER_MIGRATION);
      expect(later).toBeDefined();
      await client.run(
        `INSERT INTO __drizzle_migrations
          (hash, created_at, name, applied_at)
         VALUES (?, ?, ?, ?)`,
        later?.hash,
        later?.folderMillis,
        later?.name,
        new Date().toISOString(),
      );

      const database = drizzle({ client });
      await migrate(database, { migrationsFolder });
      await migrate(database, { migrationsFolder });

      const probeRows = await client.all(
        'SELECT name FROM migration_probe ORDER BY name',
      ) as Array<{ name: string }>;
      const migrationRows = await client.all(
        'SELECT name FROM __drizzle_migrations ORDER BY name',
      ) as Array<{ name: string }>;
      const expectedNames = [...RESTORED_MIGRATIONS, LATER_MIGRATION].sort();

      expect(probeRows.map((row) => row.name)).toEqual(expectedNames);
      expect(migrationRows.map((row) => row.name)).toEqual(expectedNames);
    } finally {
      if (client.open) await client.close();
      rmSync(migrationsFolder, { recursive: true, force: true });
    }
  });
});
