import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Database } from '@tursodatabase/database';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  'drizzle/20260718262000_handle_hint_caps/migration.sql',
);

describe('durable unverified handle-hint caps', () => {
  it('enforces both the per-node and global insert ceilings', async () => {
    const client = new Database(':memory:');
    await client.connect();
    try {
      await client.exec(`
        CREATE TABLE handle_registry (
          handle text PRIMARY KEY,
          did text NOT NULL,
          node_domain text NOT NULL,
          identity_verified integer NOT NULL,
          updated_at integer NOT NULL
        )
      `);

      const seed = [
        ...Array.from({ length: 199 }, (_, index) => (
          `('same-${index}@same.social','did:same:${index}','same.social',0,0)`
        )),
        ...Array.from({ length: 4_800 }, (_, index) => (
          `('other-${index}@node-${index}.social','did:other:${index}','node-${index}.social',0,0)`
        )),
      ];
      await client.exec(`INSERT INTO handle_registry VALUES ${seed.join(',')}`);
      await client.exec(readFileSync(migrationPath, 'utf8')
        .replaceAll('--> statement-breakpoint', ''));

      await client.run(
        `INSERT INTO handle_registry VALUES (?, ?, ?, 0, 0)`,
        'same-last@same.social',
        'did:same:last',
        'same.social',
      );
      await client.run(
        `INSERT INTO handle_registry VALUES (?, ?, ?, 0, 0)`,
        'global-overflow@overflow.social',
        'did:overflow',
        'overflow.social',
      );
      await client.run(
        `INSERT INTO handle_registry VALUES (?, ?, ?, 0, 0)`,
        'same-overflow@same.social',
        'did:same:overflow',
        'same.social',
      );

      expect(await client.get(
        `SELECT count(*) AS count FROM handle_registry`,
      )).toEqual({ count: 5_000 });
      expect(await client.get(
        `SELECT count(*) AS count FROM handle_registry WHERE node_domain = 'same.social'`,
      )).toEqual({ count: 200 });
    } finally {
      await client.close();
    }
  });
});
