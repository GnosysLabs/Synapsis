import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from '@tursodatabase/database';
import { drizzle } from 'drizzle-orm/tursodatabase/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { relations } from '@/db/relations';
import {
  consumeFederationNodeActionQuota,
  FEDERATED_NODE_ACTION_QUOTA_WINDOW_MS,
} from './action-quota';

const NOW = 1_750_000_020_000;
const migrationPath = resolve(
  'drizzle/20260718230000_federation_action_quota/migration.sql',
);

function testDatabase(client: Database) {
  return drizzle({ client, relations });
}

type TestDatabase = ReturnType<typeof testDatabase>;

describe('durable federation source-node action quota', () => {
  let directory: string;
  let databasePath: string;
  let client: Database;
  let database: TestDatabase;
  let extraClients: Database[];

  async function openDatabase() {
    client = new Database(databasePath);
    await client.connect();
    database = testDatabase(client);
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'synapsis-federation-quota-'));
    databasePath = join(directory, 'quota.db');
    extraClients = [];
    await openDatabase();
    const migration = readFileSync(migrationPath, 'utf8')
      .replaceAll('--> statement-breakpoint', '');
    await client.exec(migration);
  });

  afterEach(async () => {
    await Promise.all(extraClients.map((extraClient) => extraClient.close()));
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('atomically admits no more than the source-node limit', async () => {
    const workers = await Promise.all(Array.from({ length: 20 }, async () => {
      const workerClient = new Database(databasePath);
      await workerClient.connect();
      extraClients.push(workerClient);
      return testDatabase(workerClient);
    }));
    const results = await Promise.all(workers.map((workerDatabase) => (
      consumeFederationNodeActionQuota({
        sourceDomain: 'remote.social',
        limit: 5,
        now: NOW,
        database: workerDatabase,
      })
    )));

    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results.filter((result) => !result.allowed)).toHaveLength(15);
    expect(await client.get(
      `SELECT action_count AS actionCount
       FROM swarm_federation_action_quota_buckets
       WHERE source_domain = 'remote.social'`,
    )).toEqual({ actionCount: 5 });
  });

  it('persists the exhausted bucket across a database reconnect', async () => {
    await expect(consumeFederationNodeActionQuota({
      sourceDomain: 'HTTPS://REMOTE.SOCIAL/delivery',
      limit: 1,
      now: NOW,
      database,
    })).resolves.toMatchObject({ allowed: true, count: 1 });

    await client.close();
    await openDatabase();

    await expect(consumeFederationNodeActionQuota({
      sourceDomain: 'remote.social',
      limit: 1,
      now: NOW,
      database,
    })).resolves.toMatchObject({ allowed: false, count: 1, remaining: 0 });
  });

  it('isolates source nodes and opens a fresh fixed window', async () => {
    const firstRemote = await consumeFederationNodeActionQuota({
      sourceDomain: 'remote.social',
      limit: 1,
      now: NOW,
      database,
    });
    const otherRemote = await consumeFederationNodeActionQuota({
      sourceDomain: 'other.social',
      limit: 1,
      now: NOW,
      database,
    });
    const nextWindow = await consumeFederationNodeActionQuota({
      sourceDomain: 'remote.social',
      limit: 1,
      now: NOW + FEDERATED_NODE_ACTION_QUOTA_WINDOW_MS,
      database,
    });

    expect(firstRemote.allowed).toBe(true);
    expect(otherRemote.allowed).toBe(true);
    expect(nextWindow).toMatchObject({ allowed: true, count: 1 });
  });

  it('deletes at most the configured number of expired buckets per consume', async () => {
    const currentBucketStart = Math.floor(
      NOW / FEDERATED_NODE_ACTION_QUOTA_WINDOW_MS,
    ) * FEDERATED_NODE_ACTION_QUOTA_WINDOW_MS;
    for (let index = 0; index < 10; index += 1) {
      await client.run(
        `INSERT INTO swarm_federation_action_quota_buckets
          (source_domain, bucket_start_ms, action_count, updated_at)
         VALUES (?, ?, 1, 0)`,
        `expired-${index}.social`,
        currentBucketStart - ((index + 1) * FEDERATED_NODE_ACTION_QUOTA_WINDOW_MS),
      );
    }

    await consumeFederationNodeActionQuota({
      sourceDomain: 'remote.social',
      limit: 10,
      now: NOW,
      cleanupBatchSize: 3,
      database,
    });

    expect(await client.get(
      `SELECT COUNT(*) AS count
       FROM swarm_federation_action_quota_buckets
       WHERE bucket_start_ms < ?`,
      currentBucketStart,
    )).toEqual({ count: 7 });
  });
});
