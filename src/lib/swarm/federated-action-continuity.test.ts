import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from '@tursodatabase/database';
import { drizzle } from 'drizzle-orm/tursodatabase/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { relations } from '@/db/relations';
import { upsertHandleEntries } from '@/lib/federation/handles';
import {
  FederatedIdentityContinuityError,
  pinVerifiedFederatedActorIdentity,
} from './federated-action';

const migrationPath = resolve(
  'drizzle/20260718240000_verified_handle_identity/migration.sql',
);

function testDatabase(client: Database) {
  return drizzle({ client, relations });
}

type TestDatabase = ReturnType<typeof testDatabase>;

async function createLegacyHandleRegistry(client: Database): Promise<void> {
  await client.exec(`
    CREATE TABLE handle_registry (
      handle text PRIMARY KEY NOT NULL,
      did text NOT NULL,
      node_domain text NOT NULL,
      registered_at integer DEFAULT (unixepoch()) NOT NULL,
      updated_at integer DEFAULT (unixepoch()) NOT NULL
    );
    CREATE INDEX handle_registry_updated_idx ON handle_registry (updated_at);
  `);
}

async function applyIdentityMigration(client: Database): Promise<void> {
  const migration = readFileSync(migrationPath, 'utf8')
    .replaceAll('--> statement-breakpoint', '');
  await client.exec(migration);
}

describe('verified federated actor continuity', () => {
  let directory: string;
  let databasePath: string;
  let client: Database;
  let database: TestDatabase;
  let extraClients: Database[];

  beforeEach(async () => {
    vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'local.social');
    directory = mkdtempSync(join(tmpdir(), 'synapsis-verified-identity-'));
    databasePath = join(directory, 'identity.db');
    extraClients = [];
    client = new Database(databasePath);
    await client.connect();
    await createLegacyHandleRegistry(client);
    await client.exec('PRAGMA journal_mode = WAL');
    database = testDatabase(client);
  });

  afterEach(async () => {
    await Promise.all(extraClients.map((extraClient) => extraClient.close()));
    await client.close();
    rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function openWorkerDatabase(): Promise<TestDatabase> {
    const workerClient = new Database(databasePath);
    await workerClient.connect();
    extraClients.push(workerClient);
    return testDatabase(workerClient);
  }

  it('migrates local ownership as verified while preserving remote rows as hints', async () => {
    await client.run(
      'INSERT INTO handle_registry (handle, did, node_domain) VALUES (?, ?, ?)',
      'alice',
      'did:key:local',
      'local.social',
    );
    await client.run(
      'INSERT INTO handle_registry (handle, did, node_domain) VALUES (?, ?, ?)',
      'bob@remote.social',
      'did:key:unverified-remote-hint',
      'remote.social',
    );

    await applyIdentityMigration(client);

    expect(await client.all(
      `SELECT handle, identity_verified AS identityVerified
       FROM handle_registry ORDER BY handle`,
    )).toEqual([
      { handle: 'alice', identityVerified: 1 },
      { handle: 'bob@remote.social', identityVerified: 0 },
    ]);
  });

  it('atomically upgrades a poisoned directory hint with the first valid user proof', async () => {
    await applyIdentityMigration(client);
    await client.run(
      `INSERT INTO handle_registry
        (handle, did, node_domain, identity_verified)
       VALUES (?, ?, ?, false)`,
      'alice@remote.social',
      'did:key:poisoned-hint',
      'remote.social',
    );

    await expect(pinVerifiedFederatedActorIdentity({
      sourceDomain: 'REMOTE.SOCIAL',
      actorHandle: '@Alice',
      did: 'did:key:valid-signer',
    }, database)).resolves.toEqual({
      sourceDomain: 'remote.social',
      actorHandle: 'alice',
      qualifiedHandle: 'alice@remote.social',
      did: 'did:key:valid-signer',
    });

    expect(await client.get(
      `SELECT did, node_domain AS nodeDomain,
              identity_verified AS identityVerified
       FROM handle_registry WHERE handle = 'alice@remote.social'`,
    )).toEqual({
      did: 'did:key:valid-signer',
      nodeDomain: 'remote.social',
      identityVerified: 1,
    });
  });

  it('converges concurrent competing proofs on one immutable verified DID', async () => {
    await applyIdentityMigration(client);
    await client.run(
      `INSERT INTO handle_registry
        (handle, did, node_domain, identity_verified)
       VALUES (?, ?, ?, false)`,
      'alice@remote.social',
      'did:key:directory-hint',
      'remote.social',
    );
    const workers = await Promise.all(
      Array.from({ length: 8 }, () => openWorkerDatabase()),
    );
    const attempts = workers.map((worker, index) => ({
      database: worker,
      did: index % 2 === 0 ? 'did:key:first-candidate' : 'did:key:second-candidate',
    }));

    const results = await Promise.allSettled(attempts.map(({ database: worker, did }) => (
      pinVerifiedFederatedActorIdentity({
        sourceDomain: 'remote.social',
        actorHandle: 'alice',
        did,
      }, worker)
    )));
    const stored = await client.get(
      `SELECT did, identity_verified AS identityVerified
       FROM handle_registry WHERE handle = 'alice@remote.social'`,
    ) as { did: string; identityVerified: number } | undefined;
    const winner = stored?.did;

    expect(stored?.identityVerified).toBe(1);
    expect(winner).toMatch(/^did:key:(?:first|second)-candidate$/);
    for (const [index, result] of results.entries()) {
      if (attempts[index].did === winner) {
        expect(result.status).toBe('fulfilled');
      } else {
        expect(result).toMatchObject({
          status: 'rejected',
          reason: expect.any(FederatedIdentityContinuityError),
        });
      }
    }
  });

  it('accepts the same verified identity and rejects a later conflicting DID', async () => {
    await applyIdentityMigration(client);
    const input = {
      sourceDomain: 'remote.social',
      actorHandle: 'alice',
      did: 'did:key:alice',
    };

    await pinVerifiedFederatedActorIdentity(input, database);
    await expect(pinVerifiedFederatedActorIdentity(input, database)).resolves.toMatchObject({
      did: 'did:key:alice',
    });
    await expect(pinVerifiedFederatedActorIdentity({
      ...input,
      did: 'did:key:attacker',
    }, database)).rejects.toBeInstanceOf(FederatedIdentityContinuityError);
  });

  it('does not let one verified DID impersonate multiple handles on a node', async () => {
    await applyIdentityMigration(client);
    await pinVerifiedFederatedActorIdentity({
      sourceDomain: 'remote.social',
      actorHandle: 'alice',
      did: 'did:key:shared-signer',
    }, database);

    await expect(pinVerifiedFederatedActorIdentity({
      sourceDomain: 'remote.social',
      actorHandle: 'bob',
      did: 'did:key:shared-signer',
    }, database)).rejects.toBeInstanceOf(FederatedIdentityContinuityError);
    await expect(pinVerifiedFederatedActorIdentity({
      sourceDomain: 'other.social',
      actorHandle: 'bob',
      did: 'did:key:shared-signer',
    }, database)).resolves.toMatchObject({ qualifiedHandle: 'bob@other.social' });
  });

  it('keeps directory merges unverified and marks local registration explicitly verified', async () => {
    await applyIdentityMigration(client);
    await upsertHandleEntries([{
      handle: 'alice',
      did: 'did:key:remote-hint',
      nodeDomain: 'remote.social',
    }], { authoritativeDomain: 'remote.social' }, database);
    await upsertHandleEntries([{
      handle: 'owner',
      did: 'did:key:local-owner',
      nodeDomain: 'local.social',
    }], {
      authoritativeDomain: 'local.social',
      identityVerified: true,
      allowIdentityChange: true,
    }, database);

    expect(await client.all(
      `SELECT handle, identity_verified AS identityVerified
       FROM handle_registry ORDER BY handle`,
    )).toEqual([
      { handle: 'alice@remote.social', identityVerified: 0 },
      { handle: 'owner', identityVerified: 1 },
    ]);
  });

  it('does not let a later unverified hint overwrite a verified identity', async () => {
    await applyIdentityMigration(client);
    await pinVerifiedFederatedActorIdentity({
      sourceDomain: 'remote.social',
      actorHandle: 'alice',
      did: 'did:key:verified-alice',
    }, database);

    const merge = await upsertHandleEntries([{
      handle: 'alice',
      did: 'did:key:later-directory-poison',
      nodeDomain: 'remote.social',
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
    }], { authoritativeDomain: 'remote.social' }, database);

    expect(merge).toMatchObject({ updated: 0, rejected: 1 });
    expect(await client.get(
      `SELECT did, identity_verified AS identityVerified
       FROM handle_registry WHERE handle = 'alice@remote.social'`,
    )).toEqual({ did: 'did:key:verified-alice', identityVerified: 1 });
  });

  it('keeps the same bare handle independent across authoritative nodes', async () => {
    await applyIdentityMigration(client);
    const [first, second] = await Promise.all([
      pinVerifiedFederatedActorIdentity({
        sourceDomain: 'one.social',
        actorHandle: 'alice',
        did: 'did:key:one',
      }, database),
      pinVerifiedFederatedActorIdentity({
        sourceDomain: 'two.social',
        actorHandle: 'alice',
        did: 'did:key:two',
      }, database),
    ]);

    expect(first.qualifiedHandle).toBe('alice@one.social');
    expect(second.qualifiedHandle).toBe('alice@two.social');
    expect(await client.get(
      'SELECT COUNT(*) AS count FROM handle_registry',
    )).toEqual({ count: 2 });
  });
});
