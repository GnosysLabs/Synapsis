import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Database } from '@tursodatabase/database';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  'drizzle/20260718273000_repair_remote_identity_aliases/migration.sql',
);

describe('remote identity alias repair migration', () => {
  it('keeps local pins, demotes false remote pins, and restores only proof-backed aliases', async () => {
    const client = new Database(':memory:');
    await client.connect();

    try {
      await client.exec(`
        CREATE TABLE nodes (
          domain text NOT NULL UNIQUE
        );
        CREATE TABLE handle_registry (
          handle text PRIMARY KEY NOT NULL,
          did text NOT NULL,
          node_domain text NOT NULL,
          identity_verified integer DEFAULT false NOT NULL,
          deleted_at integer,
          updated_at integer DEFAULT (unixepoch()) NOT NULL
        );
        CREATE UNIQUE INDEX handle_registry_verified_node_did_unique_idx
          ON handle_registry (node_domain, did)
          WHERE identity_verified = true;
        CREATE TABLE e2ee_remote_key_bundles (
          did text PRIMARY KEY NOT NULL,
          handle text NOT NULL
        );

        INSERT INTO nodes (domain) VALUES ('local.social');
        INSERT INTO handle_registry
          (handle, did, node_domain, identity_verified)
        VALUES
          ('alice', 'did:key:local-alice', 'local.social', true),
          ('bob', 'did:key:remote-bob', 'remote.social', true),
          ('bob@remote.social', 'did:key:remote-bob', 'remote.social', false),
          ('mallory', 'did:key:remote-mallory', 'remote.social', true),
          ('mallory@remote.social', 'did:key:remote-mallory', 'remote.social', false),
          ('carol@other.social', 'did:key:remote-carol', 'other.social', true),
          ('deleted', 'did:key:remote-deleted', 'remote.social', true),
          ('deleted@remote.social', 'did:key:remote-deleted', 'remote.social', false);
        UPDATE handle_registry
          SET deleted_at = unixepoch()
          WHERE handle = 'deleted@remote.social';

        INSERT INTO e2ee_remote_key_bundles (did, handle)
        VALUES
          ('did:key:remote-bob', '@BOB@REMOTE.SOCIAL'),
          ('did:key:remote-deleted', 'deleted@remote.social');
      `);

      await client.exec(readFileSync(migrationPath, 'utf8')
        .replaceAll('--> statement-breakpoint', ''));

      expect(await client.all(`
        SELECT handle, identity_verified AS identityVerified
        FROM handle_registry
        ORDER BY handle
      `)).toEqual([
        { handle: 'alice', identityVerified: 1 },
        { handle: 'bob', identityVerified: 0 },
        { handle: 'bob@remote.social', identityVerified: 1 },
        { handle: 'carol@other.social', identityVerified: 1 },
        { handle: 'deleted', identityVerified: 0 },
        { handle: 'deleted@remote.social', identityVerified: 0 },
        { handle: 'mallory', identityVerified: 0 },
        { handle: 'mallory@remote.social', identityVerified: 0 },
      ]);
    } finally {
      await client.close();
    }
  });
});
